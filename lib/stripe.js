require('../scripts/_env')();
const Stripe = require('stripe');

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new Error('STRIPE_SECRET_KEY is missing.');

const stripe = new Stripe(secretKey);

module.exports = stripe;
