const InjectPlugin = require('webpack-inject-plugin').default;
// const { writeFileSync } = require('fs');
const { createServer } = require('http');
// const { Cert } = require('selfsigned-ca');
// const path = require('path');
const ws = require('ws');

module.exports = class HotReloadPlugin {
  constructor(config) {
    this.#config = { port: 3090, ...config };
    this.#clearLog();
    this.#clients = new Set();
    this.#startListener();
  }

  #config = null;
  #clients = null;

  /** @type WebSocket */
  #socket = null;

  #createClientCode() {
    const { port } = this.#config;
    return () => `
      let connectToHotReloadPluginTimerId;
      function connectToHotReloadPlugin() {
        const ws=new WebSocket('ws://localhost:${port}');
        ws.onerror = () => ws.close();
        ws.onmessage = () => setTimeout(() => location.reload(), 1000);
        ws.onclose = () => { connectToHotReloadPluginTimerId = setTimeout(connectToHotReloadPlugin, 10000); };
        ws.onopen = () => clearInterval(connectToHotReloadPluginTimerId);
      }
      connectToHotReloadPlugin();
    `;
  }

  async #startListener() {
    try {

      const { port } = this.#config;
      // const certsPath = path.resolve(__dirname, './certs/server').replace(/\\/g, '/');
      this.#log('Starting listener', { port });
      // const serverCert = new Cert(certsPath);
      // this.#log('Loading SSL certificate...', { certsPath });
      // await serverCert.load();
      // this.#log('Loaded SSL certificate, creating server...');
      const server = createServer({
        // key: serverCert.key,
        // cert: serverCert.cert,
        // ca: serverCert.caCert,
        rejectUnauthorized: false,
        requestCert: false,
      }).listen(port);
      this.#log('Server started, starting websocket...');
      this.#socket = new ws.Server({ secure: true, host: 'localhost', path: '/', server });
      this.#log('Websocket started, adding event handlers...');
      this.#socket.on('connection', client => {
        this.#log('Client connected');
        this.#clients.add(client);
        client.on('close', () => {
          this.#log('Client disconnected');
          this.#clients.delete(client);
        });
      });
      this.#log('Event handlers added, all done.');
    } catch (e) {
      this.#log('Error occurred!', { error: e });
    }
  }

  #clearLog() {
    // writeFileSync(path.resolve(__dirname, './WebpackHotReloadPlugin.log'), '', { flag: 'w' });
  }

  #log(message, data) {
    if (data != null) message = `${message}\n${JSON.stringify(data, null, 2)}`;
    // writeFileSync(path.resolve(__dirname, './WebpackHotReloadPlugin.log'), `${message}\n`, { flag: 'a' });
  }

  apply(compiler) {
    new InjectPlugin(this.#createClientCode()).apply(compiler);
    compiler.hooks.afterEmit.tap('HotReloadPlugin', () => {
      this.#clients.forEach(client => client.send('reload'));
    });
  }

};
