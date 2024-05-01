const Order = require("../model/orderModel");
const Cart = require("../model/cartModel");
const Offer = require("../model/offerModel");
const Product = require("../model/productModel");
const User = require("../model/userModel");
const Coupon = require("../model/couponModel");
const crypto = require("crypto");
const path = require("path");
const easyInvoice = require("easyinvoice");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const paypal = require("paypal-rest-sdk");
const { couponAmount } = require("./couponController");
const env = require("dotenv").config();

paypal.configure({
  mode: process.env.PAYPAL_MODE,
  client_id: process.env.PAYPAL_CLIENT_ID,
  client_secret: process.env.PAYPAL_SECRET,
});

const decreaseProductQuantity = async (products) => {
  for (let i = 0; i < products.length; i++) {
    let product = products[i].productId;
    let count = products[i].count;
    await Product.updateOne({ _id: product }, { $inc: { quantity: -count } });
  }
};

async function calculateTotalAmountWithOffers(cartData) {
  let totalAmount = 0;
  let totalAmountBeforeDiscounts = 0;
  let productOfferAmounts = [];
  let totalDiscount = 0;
  let discount = 0;

  for (const item of cartData.products) {
    if (!item.productId || !item.productId.price || !item.count) {
      console.error("Missing product data for item:", item);
    } else {
      let itemPrice = item.productId.price * item.count;
      totalAmountBeforeDiscounts += item.productId.price * item.count;
      let applicableOffers = await Offer.find({
        $or: [
          { productId: item.productId._id },
          { categoryId: item.productId.category },
        ],
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
        is_block: 0,
      });

      let mostSignificantOffer = null;
      const productOffer = applicableOffers.find((offer) =>
        offer.productId.some((id) => id.equals(item.productId._id))
      );
      const categoryOffer = applicableOffers.find((offer) =>
        offer.categoryId.some((id) => id.equals(item.productId.category))
      );
      if (productOffer && categoryOffer) {
        mostSignificantOffer =
          productOffer.discountAmount > categoryOffer.discountAmount
            ? productOffer
            : categoryOffer;
      } else if (productOffer) {
        mostSignificantOffer = productOffer;
      } else if (categoryOffer) {
        mostSignificantOffer = categoryOffer;
      }

      if (mostSignificantOffer) {
        if (itemPrice === 0) {
          totalAmount += 0;
        } else {
          discount = Math.floor(
            itemPrice * (mostSignificantOffer.discountAmount / 100)
          )
            ? Math.floor(
                itemPrice * (mostSignificantOffer.discountAmount / 100)
              )
            : 0;
          itemPrice -= discount;
          totalDiscount += discount;
          let productOfferAmount = {
            productId: item.productId._id,
            discount: discount,
          };
          productOfferAmounts.push(productOfferAmount);
          console.log("type", typeof totalDiscount, totalDiscount);
          console.log(
            `Product: ${item.productId.name}, Price: ${item.productId.price}, Count: ${item.count}, Discount: ${discount}`
          );
        }
      }
      totalAmount += itemPrice;
    }
  }

  console.log("Total Amount After Discount:", totalAmount);
  console.log("Total Amount Before Discount:", totalAmountBeforeDiscounts);
  console.log("total discout", totalDiscount);
  console.log("dis", discount);
  return {
    totalAmount,
    totalAmountBeforeDiscounts,
    totalDiscount,
    productOfferAmounts,
  };
}
async function createOrder(
  user_id,
  cartData,
  totalAmount,
  paymentMethod,
  address,
  productOfferAmounts,
  status
) {
  const uniqId = crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .slice(0, 8);

  const orderProducts = cartData.products.map((product) => {
    const productDiscount =
      productOfferAmounts.find(
        (offer) => offer.productId === product.productId._id
      )?.discount || 0;
    const discountedPrice =
      product.productId.price - productDiscount / product.count;
    console.log("discoun", discountedPrice, productDiscount);
    if (paymentMethod == "COD" || paymentMethod == "wallet") {
      status = "placed";
    }

    return {
      productId: product.productId._id,
      name: product.productId.name,
      count: product.count,
      productPrice: product.productId.price,
      image: product.productId.images[0],
      totalPrice: discountedPrice * product.count,
      productStatus: status,
    };
  });

  const order = new Order({
    user: user_id,
    orderId: uniqId,
    deliveryDetails: address ? address : req.session.address,
    products: orderProducts,
    date: new Date(),
    orderStatus:status,
    totalAmount: totalAmount < 1500 ? totalAmount + 90 : totalAmount,
    paymentMethod: paymentMethod,
    shippingMethod: cartData.shippingMethod,
    shippingAmount: totalAmount < 1500 ? 90 : 0,
  });

  try {
    const orderData = await order.save();
    await decreaseProductQuantity(cartData.products);
    return orderData._id;
  } catch (error) {
    console.error("Error saving order:", error);
    res.status(500).render("500")
   
  }
}


async function handlePayPalPayment(create_payment_json) {
  return new Promise((resolve, reject) => {
    paypal.payment.create(create_payment_json, function (error, payment) {
      if (error) {
        if (error.response && error.response.name === "VALIDATION_ERROR") {
          reject(
            new Error(
              "PayPal validation error. Please check your order details."
            )
          );
        } else {
          reject(error);
        }
      } else {
        for (let i = 0; i < payment.links.length; i++) {
          if (payment.links[i].rel === "approval_url") {
            resolve(payment.links[i].href);
          }
        }
      }
    });
  });
}

const placeOrder = async (req, res) => {
  try {
    const user_id = req.session.user_id;
    const userData = await User.findById({ _id: user_id });
    const cartData = await Cart.findOne({ user: user_id }).populate(
      "products.productId"
    );
    if (!cartData || !cartData.products || cartData.products.length === 0) {
      res.status(404).json({ error: "Cart data not found" });
      return;
    }

    const paymentMethod = req.body.formData.payment;
    let address = req.body.formData.address;
    req.session.address = address;
    let {
      totalAmount,
      totalAmountBeforeDiscounts,
      totalDiscount,
      productOfferAmounts,
    } = await calculateTotalAmountWithOffers(cartData);
    let couponAmount = 0;
    if (cartData.appliedCoupon) {
      const appliedCouponData = await Coupon.findById(cartData.appliedCoupon);
      couponAmount = Math.floor(
        totalAmount * (appliedCouponData.discountAmount / 100)
      );
      totalAmount -= couponAmount;
      console.log("couponnnnnnnnnnnnns", couponAmount, totalAmount);
      appliedCouponData.usedUser.push(user_id);
      await appliedCouponData.save();
    }

    if (paymentMethod === "paypal") {
      items = cartData.products.map((product) => ({
        name: product.productId.name,
        sku: product.productId._id,
        price: product.productId.price.toFixed(2),
        currency: "USD",
        quantity: product.count,
      }));

      let shippingAmount = totalAmount < 1500 ? 90 : 0;
      if (shippingAmount > 0) {
        items.push({
          name: "Shipping Fee",
          sku: "SHIPPING",
          price: shippingAmount.toFixed(2),
          currency: "USD",
          quantity: 1,
        });

        totalAmount += shippingAmount;
      }

      if (totalAmount !== totalAmountBeforeDiscounts) {
        totalDiscount = totalDiscount + couponAmount;
        console.log("totaldicscout", totalDiscount);
        items.push({
          name: "DISCOUNT",
          sku: "DISCOUNT",
          price: -totalDiscount,
          currency: "USD",
          quantity: 1,
        });
      }
      console.log("total", totalAmount, shippingAmount);

      const create_payment_json = {
        intent: "sale",
        payer: {
          payment_method: "paypal",
        },
        redirect_urls: {
          return_url: "http://localhost:7000/paypal-success",
          cancel_url: "http://localhost:7000/paypal-cancel",
        },
        transactions: [
          {
            item_list: {
              items: items,
            },
            amount: {
              currency: "USD",
              total: totalAmount.toFixed(2),
            },
            description: "Payment for order",
          },
        ],
      };

      const paypalUrl = await handlePayPalPayment(create_payment_json);
      res.json({ paypal: paypalUrl });
    } else if (paymentMethod == "COD") {
      const orderId = await createOrder(
        user_id,
        cartData,
        totalAmount,
        paymentMethod,
        address,
        productOfferAmounts
      );
      await Cart.deleteOne({ user: user_id });
      res.json({ codsuccess: true, orderId });
    } else {
      console.log('totaal',totalAmount);
      if (userData.wallet >= totalAmount) {
        const wallet = await User.findOneAndUpdate(
          { _id: user_id },
          {
            $inc: { wallet:totalAmount<1500?-(totalAmount+90):-totalAmount},
            $push: {
              walletHistory: {
                date: new Date(),
                amount:totalAmount<1500?-(totalAmount+90):-totalAmount,
                direction: "Debit",
              },
            },
          },
          { new: true }
        );
        let paymentMethod = "wallet"
        const orderId = await createOrder(
          user_id,
          cartData,
          totalAmount,
          paymentMethod,
          address,
          productOfferAmounts
        );
        await Cart.deleteOne({ user: user_id });
        return res.json({ wallet: true });
      } else {
        return res.json({ walletAmount: true });
      }
    }
  } catch (error) {
    console.error("while order placing", error);
    res.status(500).render("500");
  }
};

const paypalSuccess = async (req, res) => {
  try {
    const user_id = req.session.user_id;
    const cartData = await Cart.findOne({ user: user_id }).populate(
      "products.productId"
    );
    if (!cartData || !cartData.products || cartData.products.length === 0) {
      res.status(404).json({ error: "Cart data not found" });
      return;
    }
    let { totalAmount, productOfferAmounts } =
      await calculateTotalAmountWithOffers(cartData);
      let paymentMethod='paypal'
      let status = "placed"
      let address=req.session.address
    const orderId = await createOrder(
      user_id,
      cartData,
      totalAmount,
      paymentMethod,
      address,
      productOfferAmounts,
      status
    );
    await Cart.deleteOne({ user: user_id });
    res.status(200).redirect("/order-success");
  } catch (error) {
    console.log("while loading paypal success", error);
    res.status(500).render("500");
  }
};

const payNow = async (req,res) => {
  try {
    const orderData = await Order.findById({_id:req.body.orderId})
    req.session.orderId = req.body.orderId
    const create_payment_json = {
      intent: "sale",
      payer: {
         payment_method: "paypal",
      },
      transactions: [{
         amount: {
           total: orderData.totalAmount.toFixed(2),
           currency: "USD"
         },
         description: "Payment for order"
      }],
      redirect_urls: {
         return_url: "http://localhost:7000/order-success",
         cancel_url: "http://localhost:7000/paypal-cancel"
      }
     };
     const paypalUrl = await handlePayPalPayment(create_payment_json);
      res.json({ paypal: paypalUrl });
     

  } catch (error) {
    console.log('while repaying failed one',error);
    res.status(500).render('500')
  }
}

const paypalCancel = async (req, res) => {
  try {
    const user_id = req.session.user_id;
    const cartData = await Cart.findOne({ user: user_id }).populate(
      "products.productId"
    );
    if (!cartData || !cartData.products || cartData.products.length === 0) {
      res.status(404).json({ error: "Cart data not found" });
      return;
    }
    let { totalAmount, productOfferAmounts } =
      await calculateTotalAmountWithOffers(cartData);
      let paymentMethod='paypal'
      let status = "Pending"
      let address=req.session.address
    const orderId = await createOrder(
      user_id,
      cartData,
      totalAmount,
      paymentMethod,
      address,
      productOfferAmounts,
      status
    );
    res.status(200).redirect('/checkout');
  } catch (error) {
    console.log("while cancelling the paypal oreder", error);
    res.status(500).render("500");
  }
};

const orderSuccess = async (req, res) => {
  try {
    console.log('idddd',req.session.orderId);
    if(req.session.orderId){
      const orderData = await Order.findById({_id:req.session.orderId})
      console.log('odddddddddddd',orderData);
      const cartData = await Cart.findOne({user:req.session.user_id})
      console.log('caaaaaaaaaaaaa',cartData);
      if (orderData) {
        orderData.orderStatus = "Placed";
        orderData.products.forEach((product) => {
          product.productStatus = "Placed"; 
        });
        await orderData.save();
        req.session.orderId = null;
        await Cart.deleteOne({ user: req.session.user_id });
      } else {
        console.log("Order not found");
      }
    }
    res.render("orderSuccess");
  } catch (error) {
    console.log(error);
  }
};

const orderDetails = async (req, res) => {
  try {
    const userId = req.body.user_id;
    const orderDetails = await Order.find({ _id: req.query._id }).populate(
      "products.productId"
    );
    res.render("orderDetails", { order: orderDetails, user: userId });
  } catch (error) {
    console.log(error);
  }
};

const cancelOrder = async (req, res) => {
  try {
    const user_Id = req.session.user_id;
    console.log("User ID:", user_Id);

    const orderId = req.body.orderId;
    const productId = req.body.productId;

    const orderedData = await Order.findOne({ _id: orderId });
    console.log("Ordered Data:", orderedData);

    const orderedProduct = orderedData.products.find((product) => {
      return product._id.toString() === productId;
    });
    console.log("oredered producttt", orderedProduct.totalPrice);

    const updateOrder = await Order.findOneAndUpdate(
      { _id: orderId, "products._id": productId },
      { $set: { "products.$.productStatus": "Cancelled" } },
      { new: true }
    );

    const updateProductQuantity = await Product.updateOne(
      { _id: orderedProduct.productId },
      { $inc: { quantity: orderedProduct.count } }
    );
    if (
      orderedData.paymentMethod == "paypal" ||
      orderedData.paymentMethod == "wallet"
    ) {
      const date = new Date();
      const UpdateWallet = await User.findOneAndUpdate(
        { _id: user_Id },
        {
          $inc: { wallet: orderedProduct.totalPrice },
          $push: {
            walletHistory: {
              date: date,
              amount: orderedProduct.totalPrice,
              direction: "Credit",
            },
          },
        },
        { new: true }
      );
      console.log("Updated Wallet:", UpdateWallet);
    }

    console.log("Product Quantity Update:", updateProductQuantity);
    return res.json({ success: true });
  } catch (error) {
    console.log("Error while cancelling the order:", error);
    return res
      .status(500)
      .json({ error: "An error occurred while cancelling the order." });
  }
};

// ------------------user load

const orderLoad = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 6;
    const skip = (page - 1) * limit;

    const totalOrders = await Order.countDocuments({
      "products.status": { $nin: ["pending"] },
    });

    const totalPages = Math.ceil(totalOrders / limit);

    const orderData = await Order.find({
      "products.status": { $nin: ["pending"] },
    })
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    res.render("order", {
      orderData,
      currentPage: page,
      totalPages: totalPages,
    });
  } catch (error) {
    console.log(error, "while loading admin order");
    res.status(500).render("500");
  }
};

const orderdetailsLoad = async (req, res) => {
  try {
    const orderId = req.query._id;
    console.log(orderId, "Order ID");

    const orderData = await Order.findOne({ _id: orderId }).populate({
      path: "products.productId",
      populate: {
        path: "category",
        select: "name",
      },
    });

    

    if (orderData) {
      const totalItems = orderData.products.reduce(
        (total, product) => total + product.count,
        0
      );
      const subtotal = orderData.products.reduce(
        (total, product) => total + product.totalPrice,
        0
      );
      const tax = subtotal * 0.1;

      res.render("orderManagment", { orderData, totalItems, subtotal, tax });
    } else {
      res.render("orderManagment", { userId: req.session.user_id });
    }
  } catch (error) {
    console.log("Error while loading orderManagement:", error);
    res.status(500).send("Internal Server Error");
  }
};

const updateOrder = async (req, res) => {
  try {
    const orderId = req.body.orderId;
    const orderStatus = req.body.status;

    const orderData = await Order.findOne({ "products._id": orderId });
    console.log("orderData:", orderData);

    const orderProductIndex = orderData.products.findIndex(
      (product) => product._id.toString() === orderId
    );
    console.log("orderProductindex:", orderProductIndex);

    const productCount = orderData.products[orderProductIndex].count;
    orderData.products[orderProductIndex].productStatus = orderStatus;
    orderData.products[orderProductIndex].date = new Date();
    console.log("count", productCount);

    if (orderStatus === "accepted") {
      const productId = orderData.products[orderProductIndex].productId;
      const productTotalPrice =
        orderData.products[orderProductIndex].totalPrice;
      const newTotalAmount = orderData.totalAmount - productTotalPrice;
      console.log("asdkkkkkkkkkkkkkkk", productTotalPrice, newTotalAmount);

      const date = new Date();
      const updateWallet = await User.findOneAndUpdate(
        { _id: orderData.user },
        {
          $inc: { wallet: productTotalPrice },
          $push: {
            walletHistory: {
              date: date,
              amount: productTotalPrice,
              direction: "Credit",
            },
          },
        },
        { new: true }
      );
      console.log("updateWallet", updateWallet);

      const updatedProduct = await Product.updateOne(
        { _id: productId },
        { $inc: { quantity: productCount } }
      );
      console.log("quantityyy productttttttttt", updatedProduct);

      const updatedOrderTotal = await Order.findByIdAndUpdate(
        orderId,
        { $set: { totalAmount: newTotalAmount } },
        { new: true }
      );
      console.log("updatedOrderTotal:", updatedOrderTotal);

      orderData.totalAmount = newTotalAmount;
    }

    const updated = await orderData.save();
    console.log("saved newwwwwww", updated);

    res.json({ success: true, orderData });
  } catch (error) {
    console.log("Error while updating order:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

const returnOrder = async (req, res) => {
  try {
    console.log("body", req.body);
    const productId = req.body.id;
    const orderId = req.body.order;
    const returnReason = req.body.returnReason;
    console.log("id", orderId);

    const order = await Order.findById(orderId).populate("products");
    console.log("orderrrr", order);
    const returnedProduct = order.products.find(
      (val) => val._id.toString() === productId
    );

    console.log("retunedd prooooo", returnedProduct);
    const productTotalPrice = returnedProduct.totalPrice;
    const newTotalAmount = order.totalAmount - productTotalPrice;
    const count = returnedProduct.count;

    console.log(
      "asdjfjdkljkljjfjfjjfjfjfjfj",
      productTotalPrice,
      newTotalAmount
    );

    const updatedOrder = await Order.updateOne(
      { _id: orderId, "products._id": productId },
      {
        $set: {
          "products.$.status": "requested",
          returnReason: returnReason,
        },
      }
    );

    // const updatedProduct = await Product.findByIdAndUpdate(
    //   { _id: productId },
    //   { $inc: { quantity: count } },
    // )

    // const updatedOrderTotal = await Order.findByIdAndUpdate(
    //   orderId,
    //   { $set: { totalAmount: newTotalAmount } },
    //   { new: true },
    // );

    res.json({ success: true });
  } catch (error) {
    console.log(error.message);
    res.status(500).render("500");
  }
};

const generateInvoicePDF = async (req, res) => {
  const orderId = req.query.id;
  const orderDetails = await Order.findById(orderId);

  if (!orderDetails) {
    return res.status(404).json({ error: "Order not found" });
  }

  let document = new PDFDocument({ margin: 50 });

  function generateHeader(document) {
    document.image("./public/user/images/logo.png", 50, 40, { width: 100 });
    document
      .fontSize(16)
      .text("Your Company Name", 180, 50, { align: "center" });
    document.fontSize(10).text("You can feel comfort", { align: "center" });
    const currentDate = new Date();
    const formattedDate = currentDate.toLocaleDateString();
    const formattedTime = currentDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    document
      .fontSize(12)
      .text("Date: " + formattedDate, 400, 70, { width: 150, align: "right" });
    document
      .fontSize(12)
      .text("Time: " + formattedTime, 400, 90, { width: 150, align: "right" });
    document.moveTo(50, 120).lineTo(550, 120).stroke();
  }

  function generateOrderDetails(document, orderDetails) {
    document.fontSize(18).text("Order Details", 50, 160);

    const headers = [
      "No.",
      "Product",
      "Quantity",
      "Price",
      "Total",
      "Status",
      "Payment Method",
    ];
    const rows = orderDetails.products.map((product, index) => {
      const productName = product.name ? product.name.toString() : "N/A";
      const productCount = product.count ? product.count.toString() : "0";
      const productPrice = product.productPrice
        ? "$" + product.productPrice.toString()
        : "$0";
      const totalPrice = product.totalPrice
        ? "$" + product.totalPrice.toString()
        : "$0";
      const productStatus = product.status ? product.status.toString() : "N/A";
      const paymentMethod = product.paymentMethod
        ? product.paymentMethod.toString()
        : "N/A";

      return [
        (index + 1).toString(),
        productName,
        productCount,
        productPrice,
        totalPrice,
        productStatus,
        paymentMethod,
      ];
    });

    const columnWidths = [30, 150, 70, 70, 70, 70, 100];
    let y = 200;

    headers.forEach((header, columnIndex) => {
      document
        .fontSize(12)
        .text(
          header,
          50 +
            columnWidths
              .slice(0, columnIndex)
              .reduce((acc, width) => acc + width, 0),
          y,
          { width: columnWidths[columnIndex], align: "center" }
        );
    });

    rows.forEach((row, rowIndex) => {
      y += 20;
      row.forEach((cell, columnIndex) => {
        document
          .fontSize(12)
          .text(
            cell,
            50 +
              columnWidths
                .slice(0, columnIndex)
                .reduce((acc, width) => acc + width, 0),
            y,
            { width: columnWidths[columnIndex], align: "center" }
          );
        if (rowIndex === 0) {
          document
            .moveTo(
              50 +
                columnWidths
                  .slice(0, columnIndex)
                  .reduce((acc, width) => acc + width, 0),
              160
            )
            .lineTo(
              50 +
                columnWidths
                  .slice(0, columnIndex)
                  .reduce((acc, width) => acc + width, 0),
              y + 20
            )
            .stroke();
        }
      });
      document.moveTo(50, y).lineTo(550, y).stroke();
    });

    const totalAmountText = "Total Amount: $" + orderDetails.totalAmount;
    document.fontSize(12).text(totalAmountText, 50, y + 20, { align: "right" });
  }

  function generateFooter(document) {
    document
      .fontSize(15)
      .text("Thanks for your presence. Please keep purchasing", {
        align: "center",
      });
  }

  generateHeader(document);
  generateOrderDetails(document, orderDetails);
  generateFooter(document);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=invoice.pdf");

  document.pipe(res);
  document.end();

  document.on("end", () => {
    console.log("PDF generation completed");
  });
};

const invoiceSuccess = async (req, res) => {
  res.json({ invoice: true });
};

module.exports = {
  placeOrder,
  payNow,
  paypalSuccess,
  paypalCancel,
  orderSuccess,
  cancelOrder,
  returnOrder,
  orderDetails,
  orderLoad,
  orderdetailsLoad,
  updateOrder,
  generateInvoicePDF,
  invoiceSuccess,
};
