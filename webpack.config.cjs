const path = require('path');
const nodeExternals = require('webpack-node-externals');
const NodemonPlugin = require('nodemon-webpack-plugin');
const CopyWebpackConfig = require('copy-webpack-plugin');
const ProgressPlugin = require('progress-webpack-plugin');
const HotModulePlugin = require('./WebpackHotReloadPlugin');
// const { ProvidePlugin } = require('webpack');
// const SocketAPIPlugin = require('./SocketAPIPlugin');
// const dotenv = require('dotenv');

const generateSettings = (name, isDev) => ({
  watch: isDev,
  name,
  ...(isDev ? {
    watchOptions: {
      ignored: /node_modules\/(?!@anupheaus).*/,
    }
  } : {}),
  output: {
    path: path.resolve(__dirname, './dist'),
    ...(isDev ? {} : { libraryTarget: 'umd' }),
    hashFunction: 'xxhash64',
  },
  module: {
    rules: [{
      test: /\.tsx?$/,
      loader: 'ts-loader',
      options: {
        onlyCompileBundledFiles: true,
        compilerOptions: {
          declaration: true,
          declarationDir: './dist',
          noEmit: false,
        },
      },
    }],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      'react': path.join(__dirname, './node_modules/react'),
      'react-dom': path.join(__dirname, './node_modules/react-dom'),
      ...isDev ? {
        '@anupheaus/socket-api/common': path.join(__dirname, '../socket-api/src/common'),
        '@anupheaus/socket-api/server': path.join(__dirname, '../socket-api/src/server'),
        '@anupheaus/socket-api/client': path.join(__dirname, '../socket-api/src/client'),
        '@anupheaus/common': path.join(__dirname, '../common/src'),
        '@anupheaus/react-ui': path.join(__dirname, '../react-ui/src'),
      } : {},
    },
  },
  plugins: [
    new ProgressPlugin({ name }),
    // new DefinePlugin({
    //   'CONFIG': JSON.stringify(dotenv.config({ path: path.resolve(__dirname, `${name}.env`) }).parsed),
    // }),
  ],
  stats: {
    assets: false,
    builtAt: true,
    cached: false,
    cachedAssets: false,
    children: false,
    chunks: false,
    chunkGroups: false,
    chunkModules: false,
    chunkOrigins: false,
    colors: true,
    depth: false,
    entrypoints: false,
    env: false,
    errors: true,
    errorDetails: true,
    hash: false,
    logging: 'error',
    modules: false,
    outputPath: false,
    performance: true,
    providedExports: false,
    publicPath: false,
    reasons: false,
    source: false,
    timings: true,
    usedExports: false,
    version: false,
    warnings: true,
  },
});

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  const clientSettings = generateSettings('client', isDev);
  const commonSettings = generateSettings('common', isDev);
  const serverSettings = generateSettings('server', isDev);

  const config = [{
    /* Client */
    ...clientSettings,
    entry: {
      client: isDev ? './test/client/index.tsx' : './src/client/index.ts',
    },
    resolve: {
      ...clientSettings.resolve,
      fallback: {
        crypto: false,
        path: false, // require.resolve('path-browserify'),
        os: false, //require.resolve('os-browserify/browser'),
        buffer: false, // require.resolve('buffer/'),
        util: false, // require.resolve('util/'),
        browser: false, //require.resolve('browser-resolve'),
        fs: false,
        async_hooks: false,
        vm: false,
        module: false,
      },
    },
    target: isDev ? 'web' : 'node',
    externals: isDev ? [] : [
      nodeExternals({
        allowlist: isDev ? [
          '@anupheaus/common',
          '@anupheaus/react-ui',
          /@anupheaus\/socket-api\/.*/,
        ] : [],
      }),
    ],
    plugins: [
      ...(clientSettings.plugins ?? []),
      ...(isDev ? [new HotModulePlugin()] : []),
      /*new ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer'],
      }),*/
    ],
    optimization: {
      splitChunks: {
        cacheGroups: {
          vendor: {
            name: 'vendors',
            test: /[\\/]node_modules[\\/]/,
            chunks: 'all',
          },
        },
      },
    },
  }, isDev ? undefined : {

    /* Common */
    ...commonSettings,
    entry: {
      common: './src/common/index.ts',
    },
    target: 'node',
    externals: [
      nodeExternals(),
    ],
  }, {

    /* Server */
    ...serverSettings,
    entry: {
      server: isDev ? './test/server/start.ts' : './src/server/index.ts',
    },
    externalsPresets: { node: true },
    target: 'node',
    externals: [
      nodeExternals({
        allowlist: isDev ? [
          '@anupheaus/common',
          '@anupheaus/react-ui',
          /@anupheaus\/socket-api\/.*/,
        ] : [],
      }),
    ],
    plugins: [
      ...(serverSettings.plugins ?? []),
      ...(isDev ? [
        new CopyWebpackConfig({
          patterns: [
            { from: './test/server/views', to: './views' },
            //     // { from: './test/server/static', to: '.' },
          ],
        }),
        new NodemonPlugin(),
      ] : []),
      // new SocketAPIPlugin({
      //   controllerRootPaths: [path.resolve(__dirname, './test/server/controllers')],
      //   generatedControllerTypesFileName: path.resolve(__dirname, './test/common/ControllerTypes.ts'),
      // }),      
    ],
  }].filter(v => v != null);

  if (argv.name != null) return config.find(({ name }) => name.toLowerCase() === argv.name.toLowerCase());
  return config;
};
