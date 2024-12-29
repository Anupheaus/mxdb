const path = require('path');
const nodeExternals = require('webpack-node-externals');
const NodemonPlugin = require('nodemon-webpack-plugin');
const CopyWebpackConfig = require('copy-webpack-plugin');
const ProgressPlugin = require('progress-webpack-plugin');
const HotModulePlugin = require('./WebpackHotReloadPlugin');
const { execSync } = require('child_process');
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
  const serverSettings = generateSettings('server', isDev);
  const commonSettings = generateSettings('common', isDev);

  execSync('rm -rf dist');

  const config = [{
    /* Client */
    ...clientSettings,
    entry: (isDev ? { client: './test/client/index.tsx' } : { index: './src/index.ts' }),
    resolve: {
      ...clientSettings.resolve,
      fallback: {
        path: false, // require.resolve('path-browserify'),
        os: false, //require.resolve('os-browserify/browser'),
        buffer: false, // require.resolve('buffer/'),
        util: false, // require.resolve('util/'),
        browser: false, //require.resolve('browser-resolve'),
        fs: false,
      },
    },
    target: isDev ? 'web' : 'node',
    externals: isDev ? [] : [
      nodeExternals(),
    ],
    plugins: [
      ...(clientSettings.plugins ?? []),
      ...(isDev ? [new HotModulePlugin()] : []),
      /*new ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer'],
      }),*/
    ],
    ...(isDev ? {
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
    } : {}),
  }, (isDev ? {

    /* Server */
    ...serverSettings,
    entry: {
      server: './test/server/start.ts',
    },
    target: 'node',
    externals: [
      nodeExternals(),
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
  } : {
    /* Common */
    ...commonSettings,
    entry: {
      common: './src/defineCollection.ts',
    },
    target: 'node',
    externals: [
      nodeExternals(),
    ],
  })].filter(v => v != null);
  if (argv.name != null) return config.find(({ name }) => name.toLowerCase() === argv.name.toLowerCase());
  return config;
};
