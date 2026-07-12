// main.js - Daily reward example
module.exports = async ({ params, context, logger }) => {
  const { playerId } = context;
  logger.info(`Daily reward for ${playerId}`);
  return { rewarded: 100, currency: "COIN", streak: params.streak || 1 };
};
