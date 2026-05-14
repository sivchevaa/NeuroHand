module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Must be last — Reanimated plugin transforms 'worklet' directives
    plugins: ['react-native-reanimated/plugin'],
  };
};
