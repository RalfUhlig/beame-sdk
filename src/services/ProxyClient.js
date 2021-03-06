/**
 * Created by zenit1 on 12/07/2016.
 */
"use strict";

const _   = require('underscore');
const net = require('net');
const io  = require('socket.io-client');

const socketUtils = require('../utils/SocketUtils');
const config      = require('../../config/Config');
const module_name = config.AppModules.ProxyClient;
const logger      = new (require('../utils/Logger'))(module_name);
/**
 * @typedef {Object} HttpsProxyAgent
 */

function nop() {
}

/**
 * @typedef {Object} ProxyClientOptions
 * @property {Function} [onConnect]
 * @property {Function} [onLocalServerCreated]
 */

class ProxyClient {

	/**
	 * @param {String} serverType
	 * @param {String} edgeClientHostname - server endpoint url
	 * @param {String} edgeServerHostname - SSL Proxy Server endpoint url
	 * @param {String} targetHost
	 * @param {Number} targetPort
	 * @param {ProxyClientOptions} options
	 * @param {HttpsProxyAgent|null|undefined} [agent]
	 * @param {ServerCertificates|null} [edgeClientCerts]
	 * @constructor
	 * @class
	 */
	constructor(serverType, edgeClientHostname, edgeServerHostname, targetHost, targetPort, options, agent, edgeClientCerts) {

		/** @member {Boolean} */
		this._connected = false;

		/** @member {Object} */
		this._clientSockets = {};

		this._type = serverType;

		/**
		 * SSL Proxy Server endpoint url
		 * @member {String} */
		this._edgeServerHostname = edgeServerHostname;

		/**
		 * server endpoint url
		 * @member {String} */
		this._hostname = edgeClientHostname;

		/** @member {String} */
		this._targetHost = targetHost;

		/** @member {Number} */
		this._targetPort = targetPort;

		//logger.debug(`ProxyClient connecting to ${this.edgeServerHostname}`);

		/**
		 * Connect to ProxyServer
		 */
		const io_options = {multiplex: false, agent: agent};

		if (edgeClientCerts) {
			io_options.cert = edgeClientCerts.cert;
			io_options.key  = edgeClientCerts.key;
			io_options.ca   = edgeClientCerts.ca;

		}

		//noinspection JSUnresolvedVariable
		this._options = options;

		this._socketio = io.connect(this._edgeServerHostname + '/control', io_options);

		this._socketio.on('connect', _.bind(function () {

			if (this._connected) {
				return;
			}
			//logger.debug(`ProxyClient connected => {hostname:${this.hostname}, endpoint:${this.edgeServerHostname}, targetHost:${this.targetHost}, targetPort: ${this.targetPort}}`);
			this._connected = true;
			socketUtils.emitMessage(this._socketio, 'register_server', socketUtils.formatMessage(null, {
				hostname: this._hostname,
				type:     this._type
			}));

			this._options && this._options.onConnect && this._options.onConnect();

		}, this));

		this._socketio.on('error', _.bind(function (err) {
			//logger.debug("Could not connect to proxy server", err);
		}, this));

		this._socketio.on('create_connection', data => {

			//noinspection JSUnresolvedVariable
			this.createLocalServerConnection(data, this._options && this._options.onConnection);
		});

		this._socketio.once('hostRegistered', _.bind(function (data) {
			this._options && this._options.onLocalServerCreated && this._options.onLocalServerCreated.call(null, data);
			//  this.createLocalServerConnection.call(this, data, this._options && this._options.onLocalServerCreated);
			//logger.debug('hostRegistered', data);
		}, this));

		this._socketio.on('data', _.bind(function (data) {
			const socketId = data.socketId;
			const socket   = this._clientSockets[socketId];
			if (socket) {
				socket.id = socketId;
				//check if connected
				process.nextTick(function () {
					socket.write(data.payload);
				});

			}
		}, this));

		this._socketio.on('socket_error', _.bind(function (data) {
			this.deleteSocket(data.socketId);
		}, this));

		this._socketio.on('_end', _.bind(function (data) {
			//logger.debug("***************Killing the socket ");
			if (!data || !data.socketId) {
				return;
			}
			setTimeout(() => {
				this.deleteSocket(data.socketId);
			}, 1000);

		}, this));

		this._socketio.on('disconnect', _.bind(function () {

			this._connected = false;
			_.each(this._clientSockets, function (socket) {
				setTimeout(() => {
					socket.destroy();
					this.deleteSocket(socket.id);
				}, 10000);
			}, this);
		}, this));
	}

	createLocalServerConnection(data, callback = nop) {
		if (!this._socketio) {
			return;
		}

		const serverSideSocketId = data.socketId;

		const client                            = new net.Socket();
		client.serverSideSocketId               = serverSideSocketId;
		this._clientSockets[serverSideSocketId] = client;

		/**
		 * Connect to local server
		 */
		client.connect(this._targetPort, this._targetHost);

		client.on('data', data => {
			socketUtils.emitMessage(this._socketio, 'data', socketUtils.formatMessage(client.serverSideSocketId, data));
		});

		client.on('close', had_error => {
			if (had_error) {
				socketUtils.emitMessage(this._socketio, '_error', socketUtils.formatMessage(client.serverSideSocketId, null, new Error('close() reported error')));
			}
			socketUtils.emitMessage(this._socketio, 'disconnect_client', socketUtils.formatMessage(client.serverSideSocketId));
			this.deleteSocket(serverSideSocketId);
		});

		client.on('error', error => {

			logger.error(`Error talking to ${this._targetHost}:${this._targetPort} - ${error}`);

			if (this._socketio) {
				// TODO: Send this event to be logged on edge server
				socketUtils.emitMessage(this._socketio, '_error', socketUtils.formatMessage(client.serverSideSocketId, null, error));
				if (error.syscall == 'connect' && error.code == 'ECONNREFUSED') {
					logger.error(`Error connecting to ${this._targetHost}:${this._targetPort} - ${error}. Closing socket.`);
					socketUtils.emitMessage(this._socketio, 'cut_client', socketUtils.formatMessage(client.serverSideSocketId));
					// client.emit('close'); -- did not work
					this.deleteSocket(serverSideSocketId);
					client.destroy();
				}
			}
		});

		callback(data);
	}

	destroy() {
		if (this._socketio) {
			this._socketio = null;
		}
		return this;
	}

	deleteSocket(socketId) {
		if (socketId && this._clientSockets[socketId]) {
			const obj = this._clientSockets[socketId];
			obj.end();
			delete this._clientSockets[socketId];
		}
	}
}


module.exports = ProxyClient;

