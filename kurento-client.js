require=(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module KurentoClient
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license LGPL
 */

var EventEmitter = require('events').EventEmitter;
var url = require('url');

var Promise = require('es6-promise').Promise;

var async = require('async');
var extend = require('extend');
var inherits = require('inherits');
var reconnect = require('reconnect-ws');

var checkType = require('checktype');

var RpcBuilder = require('kurento-jsonrpc');
var JsonRPC = RpcBuilder.packers.JsonRPC;

var promiseCallback = require('promisecallback');

var createPromise = require('./createPromise');
var MediaObjectCreator = require('./MediaObjectCreator');
var TransactionsManager = require('./TransactionsManager');

var TransactionNotCommitedException = TransactionsManager.TransactionNotCommitedException;
var transactionOperation = TransactionsManager.transactionOperation;

var MediaObject = require('kurento-client-core').abstracts.MediaObject;

const BASE_TIMEOUT = 20000;

function findIndex(list, predicate) {
  for (var i = 0, item; item = list[i]; i++)
    if (predicate(item)) return i;

  return -1;
};

/**
 * Serialize objects using their id
 */
function serializeParams(params) {
  for (var key in params) {
    var param = params[key];
    if (param instanceof MediaObject) {
      var id = param.id;

      if (id !== undefined) params[key] = id;
    }
  };

  return params;
};

function serializeOperation(operation, index) {
  var params = operation.params;

  switch (operation.method) {
  case 'create':
    params.constructorParams = serializeParams(params.constructorParams);
    break;

  default:
    params = serializeParams(params);
    params.operationParams = serializeParams(params.operationParams);
  };

  operation.jsonrpc = "2.0";

  operation.id = index;
};

function deferred(mediaObject, params, prevRpc, callback) {
  var promises = [];

  if (mediaObject != undefined)
    promises.push(mediaObject);

  for (var key in params) {
    var param = params[key];
    if (param !== undefined)
      promises.push(param);
  };

  if (prevRpc != undefined)
    promises.push(prevRpc);

  return promiseCallback(Promise.all(promises), callback);
};

function noop(error) {
  if (error) console.trace(error);
};

/**
 * Creates a connection with the Kurento Media Server
 *
 * @class
 *
 * @param {external:String} ws_uri - Address of the Kurento Media Server
 * @param {Object} [options]
 *   @property failAfter - Don't try to reconnect after several tries
 *     @default 5
 *   @property enableTransactions - Enable transactions functionality
 *     @default true
 *   @property access_token - Set access token for the WebSocket connection
 *   @property max_retries - Number of tries to send the requests
 *     @default 0
 *   @property request_timeout - Timeout between requests retries
 *     @default 20000
 *   @property response_timeout - Timeout while a response is being stored
 *     @default 20000
 *   @property duplicates_timeout - Timeout to ignore duplicated responses
 *     @default 20000
 * @param {KurentoClientApi~constructorCallback} [callback]
 */
function KurentoClient(ws_uri, options, callback) {
  if (!(this instanceof KurentoClient))
    return new KurentoClient(ws_uri, options, callback);

  var self = this;

  EventEmitter.call(this);

  // Promises to check previous RPC calls
  var prevRpc = Promise.resolve(); // request has been send
  var prevRpc_result = Promise.resolve(); // response has been received

  // Fix optional parameters
  if (options instanceof Function) {
    callback = options;
    options = undefined;
  };

  options = options || {};
  if (callback) callback = callback.bind(this)

  var failAfter = options.failAfter
  if (failAfter == undefined) failAfter = 5

  options.enableTransactions = options.enableTransactions || true

  options.request_timeout = options.request_timeout || BASE_TIMEOUT;
  options.response_timeout = options.response_timeout || BASE_TIMEOUT;
  options.duplicates_timeout = options.duplicates_timeout || BASE_TIMEOUT;

  var objects = {};

  function onNotification(message) {
    var method = message.method;
    var params = message.params.value;

    var id = params.object;

    var object = objects[id];
    if (!object)
      return console.warn("Unknown object id '" + id + "'", message);

    switch (method) {
    case 'onEvent':
      object.emit(params.type, params.data);
      break;

      //      case 'onError':
      //        object.emit('error', params.error);
      //      break;

    default:
      console.warn("Unknown message type '" + method + "'");
    };
  };

  //
  // JsonRPC
  //

  if (typeof ws_uri == 'string') {
    var access_token = options.access_token;
    if (access_token != undefined) {
      ws_uri = url.parse(ws_uri, true);
      ws_uri.query.access_token = access_token;
      ws_uri = url.format(ws_uri);

      delete options.access_token;
    };
  }

  var rpc = new RpcBuilder(JsonRPC, options, function (request) {
    if (request instanceof RpcBuilder.RpcNotification) {
      // Message is an unexpected request, notify error
      if (request.duplicated != undefined)
        return console.warning('Unexpected request:', request);

      // Message is a notification, process it
      return onNotification(request);
    };

    // Invalid message, notify error
    console.error('Invalid request instance', request);
  });

  // Select what transactions mechanism to use
  var encodeTransaction = options.enableTransactions ? commitTransactional :
    commitSerial;

  // Transactional API

  var transactionsManager = new TransactionsManager(this,
    function (operations, callback) {
      var params = {
        object: self,
        operations: operations
      };

      encodeTransaction(params, callback)
    });

  this.beginTransaction = transactionsManager.beginTransaction.bind(
    transactionsManager);
  this.endTransaction = transactionsManager.endTransaction.bind(
    transactionsManager);
  this.transaction = transactionsManager.transaction.bind(transactionsManager);

  // Encode commands

  function encode(method, params, callback) {
    self.then(function () {
        // [ToDo] Use stacktrace of caller, not from response
        rpc.encode(method, params, function (error, result) {
          if (error)
            error = extend(new Error(error.message || error), error);

          callback(error, result);
        });
      },
      function () {
        connect.call(self, function (error) {
          if (error) return callback(error);

          encode(method, params, callback);
        });
      })
  }

  function encodeCreate(transaction, params, callback) {
    if (transaction)
      return transactionOperation.call(transaction, 'create', params,
        callback);

    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'create',
        params, callback);

    callback = callback || noop;

    function callback2(error, result) {
      var mediaObject = params.object;

      if (error) {
        mediaObject.emit('_id', error);
        return callback(error);
      }

      var id = result.value;

      callback(null, registerObject(mediaObject, id));
    }

    deferred(null, params.constructorParams, null, function (error) {
      if (error) return callback(error);

      params.constructorParams = serializeParams(params.constructorParams);

      encode('create', params, callback2);
    });
  };

  /**
   * Request a generic functionality to be procesed by the server
   */
  function encodeRpc(transaction, method, params, callback) {
    if (transaction)
      return transactionOperation.call(transaction, method, params,
        callback);

    var object = params.object;
    if (object && object.transactions && object.transactions.length) {
      var error = new TransactionNotCommitedException();
      error.method = method;
      error.params = params;

      return setTimeout(callback, 0, error)
    };

    for (var key in params.operationParams) {
      var object = params.operationParams[key];

      if (object && object.transactions && object.transactions.length) {
        var error = new TransactionNotCommitedException();
        error.method = method;
        error.params = params;

        return setTimeout(callback, 0, error)
      };
    }

    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, method, params,
        callback);

    var promise = new Promise(function (resolve, reject) {
      function callback2(error, result) {
        if (error) return reject(error);

        resolve(result);
      };

      prevRpc = deferred(params.object, params.operationParams, prevRpc,
        function (error) {
          if (error) return reject(error);

          params = serializeParams(params);
          params.operationParams = serializeParams(params.operationParams);

          encode(method, params, callback2);
        })
    });

    prevRpc_result = promiseCallback(promise, callback);

    if (method == 'release') prevRpc = prevRpc_result;
  }

  // Commit mechanisms

  function commitTransactional(params, callback) {
    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction',
        params, callback);

    var operations = params.operations;

    for (var i = 0, operation; operation = operations[i]; i++) {
      var object = operation.params.object;
      if (object instanceof MediaObject && object.id === null) {
        var error = new Error('MediaObject not found in server');
        error.code = 40101;
        error.object = object;

        // Notify error to all the operations in the transaction
        operations.forEach(function (operation) {
          if (operation.method == 'create')
            operation.params.object.emit('_id', error);

          var callback = operation.callback;
          if (callback instanceof Function)
            callback(error);
        });

        return callback(error);
      }
    }

    var promises = [];

    function checkId(operation, param) {
      if (param instanceof MediaObject && param.id === undefined) {
        var index = findIndex(operations, function (element) {
          return operation != element && element.params.object ===
            param;
        });

        // MediaObject dependency is created in this transaction,
        // set a new reference ID
        if (index >= 0)
          return 'newref:' + index;

        // MediaObject dependency is created outside this transaction,
        // wait until it's ready
        promises.push(param);
      }

      return param
    }

    // Fix references to uninitialized MediaObjects
    operations.forEach(function (operation) {
      var params = operation.params;

      switch (operation.method) {
      case 'create':
        var constructorParams = params.constructorParams;
        for (var key in constructorParams)
          constructorParams[key] = checkId(operation, constructorParams[
            key]);
        break;

      default:
        params.object = checkId(operation, params.object);

        var operationParams = params.operationParams;
        for (var key in operationParams)
          operationParams[key] = checkId(operation, operationParams[key]);
      };
    });

    function callback2(error, transaction_result) {
      if (error) return callback(error);

      operations.forEach(function (operation, index) {
        var callback = operation.callback || noop;

        var operation_response = transaction_result.value[index];
        if (operation_response == undefined)
          return callback(new Error(
            'Command not executed in the server'));

        var error = operation_response.error;
        var result = operation_response.result;

        var id;
        if (result) id = result.value;

        switch (operation.method) {
        case 'create':
          var mediaObject = operation.params.object;

          if (error) {
            mediaObject.emit('_id', error);
            return callback(error)
          }

          callback(null, registerObject(mediaObject, id));
          break;

        default:
          if (error) return callback(error);

          callback(null, result);
        }
      })

      callback(null, transaction_result);
    };

    Promise.all(promises).then(function () {
        operations.forEach(serializeOperation)

        encode('transaction', params, callback2);
      },
      callback);
  }

  function commitSerial(params, callback) {
    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction',
        params, callback);

    var operations = params.operations;

    async.each(operations, function (operation) {
        switch (operation.method) {
        case 'create':
          encodeCreate(undefined, operation.params, operation.callback);
          break;

        case 'transaction':
          commitSerial(operation.params.operations, operation.callback);
          break;

        default:
          encodeRpc(undefined, operation.method, operation.params,
            operation.callback);
        }
      },
      callback)
  }

  function registerObject(mediaObject, id) {
    var object = objects[id];
    if (object) return object;

    mediaObject.emit('_id', null, id);

    objects[id] = mediaObject;

    /**
     * Remove the object from cache
     */
    mediaObject.once('release', function () {
      delete objects[id];
    });

    return mediaObject;
  }

  // Creation of objects

  /**
   * Get a MediaObject from its ID
   *
   * @param {(external:String|external:string[])} id - ID of the MediaElement
   * @callback {getMediaobjectByIdCallback} callback
   *
   * @return {external:Promise}
   */
  this.getMediaobjectById = function (id, callback) {
    return createPromise(id, describe, callback)
  };
  /**
   * @callback KurentoClientApi~getMediaobjectByIdCallback
   * @param {external:Error} error
   * @param {(module:core/abstract~MediaElement|module:core/abstract~MediaElement[])} result
   *  The requested MediaElement
   */

  var mediaObjectCreator = new MediaObjectCreator(undefined, encodeCreate,
    encodeRpc, encodeTransaction, this.getMediaobjectById.bind(this));

  function describe(id, callback) {
    var mediaObject = objects[id];
    if (mediaObject) return callback(null, mediaObject);

    var params = {
      object: id
    };

    function callback2(error, result) {
      if (error) return callback(error);

      var mediaObject = mediaObjectCreator.createInmediate(result);

      return callback(null, registerObject(mediaObject, id));
    }

    encode('describe', params, callback2);
  };

  /**
   * Create a new instance of a MediaObject
   *
   * @param {external:String} type - Type of the element
   * @param {external:string[]} [params]
   * @callback {createMediaPipelineCallback} callback
   *
   * @return {module:KurentoClientApi~KurentoClient} The Kurento client itself
   */
  this.create = mediaObjectCreator.create.bind(mediaObjectCreator);
  /**
   * @callback KurentoClientApi~createCallback
   * @param {external:Error} error
   * @param {module:core/abstract~MediaElement} result
   *  The created MediaElement
   */

  function connect(callback) {
    //
    // Reconnect websockets
    //

    var closed = false;
    var re = reconnect({
        failAfter: failAfter
      }, function (ws_stream) {
        if (closed)
          ws_stream.writable = false;

        rpc.transport = ws_stream;
      })
      .connect(ws_uri);

    // Object.defineProperty(this, '_re', {
    //   configurable: true,
    //   get: function () {
    //     return re
    //   }
    // })

    this.close = function () {
      closed = true;

      prevRpc_result.then(re.disconnect.bind(re));
    };

    re.on('fail', this.emit.bind(this, 'disconnect'));

    //
    // Promise interface ("thenable")
    //

    this.then = function (onFulfilled, onRejected) {
      return new Promise(function (resolve, reject) {
        function success() {
          re.removeListener('fail', failure);

          var result;

          if (onFulfilled)
            try {
              result = onFulfilled.call(self, self);
            } catch (exception) {
              if (!onRejected)
                console.trace('Uncaugh exception', exception)

              return reject(exception);
            }

          resolve(result);
        };

        function failure() {
          re.removeListener('connection', success);

          var result = new Error('Connection error');

          if (onRejected)
            try {
              result = onRejected.call(self, result);
            } catch (exception) {
              return reject(exception);
            } else
              console.trace('Uncaugh exception', result)

          reject(result);
        };

        if (re.connected)
          success()
        else if (!re.reconnect)
          failure()
        else {
          re.once('connection', success);
          re.once('fail', failure);
        }
      });
    };

    this.catch = this.then.bind(this, null);

    // Check for available modules in the Kurento Media Server

    var promise = this.getServerManager()
      .then(function (serverManager) {
        return serverManager.getInfo()
      })
      .then(function (info) {
        var serverModules = info.modules.map(function (module) {
          return module.name
        })

        var notInstalled = KurentoClient.register.modules.filter(
          function (module) {
            return serverModules.indexOf(module) < 0
          })

        var length = notInstalled.length
        if (length) {
          if (length === 1)
            var message = "Module '" + notInstalled[0] +
              "' is not installed in the Kurento Media Server"
          else
            var message = "Modules '" + notInstalled.slice(0, -1).join(
                "', '") + "' and '" + notInstalled[length - 1] +
              "' are not installed in the Kurento Media Server"

          var error = new Error(message)
          error.modules = notInstalled

          return Promise.reject(error)
        }

        return Promise.resolve(self)
      })

    if (callback)
      promise.then(callback.bind(undefined, null), callback);
  };
  connect.call(self, callback);
};
inherits(KurentoClient, EventEmitter);
/**
 * @callback KurentoClientApi~constructorCallback
 * @param {external:Error} error
 * @param {module:KurentoClientApi~KurentoClient} client
 *  The created KurentoClient
 */

var checkMediaElement = checkType.bind(null, 'MediaElement', 'media');

/**
 * Connect the source of a media to the sink of the next one
 *
 * @param {...module:core/abstract~MediaObject} media - A media to be connected
 * @callback {module:KurentoClientApi~connectCallback} [callback]
 *
 * @return {external:Promise}
 *
 * @throws {SyntaxError}
 */
KurentoClient.prototype.connect = function (media, callback) {
  // Fix lenght-variable arguments
  media = Array.prototype.slice.call(arguments, 0);
  callback = (typeof media[media.length - 1] == 'function') ? media.pop() :
    undefined;

  // Check if we have enought media components
  if (media.length < 2)
    throw new SyntaxError("Need at least two media elements to connect");

  // Check MediaElements are of the correct type
  media.forEach(checkMediaElement);

  // Generate promise
  var promise = new Promise(function (resolve, reject) {
    function callback(error, result) {
      if (error) return reject(error);

      resolve(result);
    };

    // Connect the media elements
    var src = media[0];

    async.each(media.slice(1), function (sink, callback) {
      src.connect(sink, callback);
      src = sink;
    }, callback);
  });

  return promiseCallback(promise, callback);
};
/**
 * @callback KurentoClientApi~connectCallback
 * @param {external:Error} error
 */

/**
 * Get a reference to the current Kurento Media Server we are connected
 *
 * @callback {module:KurentoClientApi~getServerManagerCallback} callback
 *
 * @return {external:Promise}
 */
KurentoClient.prototype.getServerManager = function (callback) {
  return this.getMediaobjectById('manager_ServerManager', callback)
};
/**
 * @callback KurentoClientApi~getServerManagerCallback
 * @param {external:Error} error
 * @param {module:core/abstract~ServerManager} server
 *  Info of the MediaServer instance
 */

// Export KurentoClient

module.exports = KurentoClient;

},{"./MediaObjectCreator":2,"./TransactionsManager":3,"./createPromise":5,"async":7,"checktype":8,"es6-promise":9,"events":17,"extend":10,"inherits":40,"kurento-client-core":88,"kurento-jsonrpc":117,"promisecallback":122,"reconnect-ws":123,"url":37}],2:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var checkParams = require('checktype').checkParams;

var createPromise = require('./createPromise');
var register = require('./register');

var Transaction = require('./TransactionsManager').Transaction;

/**
 * Get the constructor for a type
 *
 * If the type is not registered, use generic {module:core/abstracts.MediaObject}
 */
function getConstructor(type) {
  var result = register.classes[type] || register.abstracts[type];
  if (result) return result;

  console.warn("Unknown type '" + type + "', using MediaObject instead");
  return require('kurento-client-core').abstracts.MediaObject;
};

function createConstructor(item) {
  var constructor = getConstructor(item.type);

  if (constructor.create) {
    item = constructor.create(item.params);

    // Apply inheritance
    var prototype = constructor.prototype;
    inherits(constructor, getConstructor(item.type));
    extend(constructor.prototype, prototype);
  };

  constructor.item = item;

  return constructor;
}

function MediaObjectCreator(host, encodeCreate, encodeRpc, encodeTransaction,
  describe) {
  if (!(this instanceof MediaObjectCreator))
    return new MediaObjectCreator(host, encodeCreate, encodeRpc,
      encodeTransaction, describe)

  function createObject(constructor) {
    var mediaObject = new constructor()

    mediaObject.on('_describe', describe);
    mediaObject.on('_rpc', encodeRpc);

    if (mediaObject instanceof register.abstracts.Hub || mediaObject instanceof register
      .classes.MediaPipeline)
      mediaObject.on('_create', encodeCreate);

    if (mediaObject instanceof register.classes.MediaPipeline)
      mediaObject.on('_transaction', encodeTransaction);

    return mediaObject;
  };

  /**
   * Request to the server to create a new MediaElement
   */
  function createMediaObject(item, callback) {
    var transaction = item.transaction;
    delete item.transaction;

    var constructor = createConstructor(item);

    item = constructor.item;
    delete constructor.item;

    if (host instanceof register.classes.MediaPipeline)
      item.params.mediaPipeline = host;

    item.constructorParams = checkParams(item.params,
      constructor.constructorParams,
      item.type);
    delete item.params;

    if (!Object.keys(item.constructorParams).length)
      delete item.constructorParams;

    try {
      var mediaObject = createObject(constructor)
    } catch (error) {
      return callback(error)
    };

    Object.defineProperty(item, 'object', {
      value: mediaObject
    });

    encodeCreate(transaction, item, callback);

    return mediaObject
  };

  this.create = function (type, params, callback) {
    var transaction = (arguments[0] instanceof Transaction) ? Array.prototype
      .shift.apply(arguments) : undefined;

    switch (arguments.length) {
    case 1:
      params = undefined;
    case 2:
      callback = undefined;
    };

    // Fix optional parameters
    if (params instanceof Function) {
      if (callback)
        throw new SyntaxError("Nothing can be defined after the callback");

      callback = params;
      params = undefined;
    };

    params = params || {};

    if (type instanceof Array)
      return createPromise(type, createMediaObject, callback)

    type = {
      params: params,
      transaction: transaction,
      type: type
    };

    return createMediaObject(type, callback)
  };

  this.createInmediate = function (item) {
    var constructor = createConstructor(item);
    delete constructor.item;

    return createObject(constructor);
  }
}

module.exports = MediaObjectCreator;

},{"./TransactionsManager":3,"./createPromise":5,"./register":6,"checktype":8,"kurento-client-core":88}],3:[function(require,module,exports){
/*
 * (C) Copyright 2013-2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var Domain = require('domain').Domain || (function () {
  function FakeDomain() {};
  inherits(FakeDomain, require('events').EventEmitter);
  FakeDomain.prototype.run = function (fn) {
    try {
      fn()
    } catch (err) {
      this.emit('error', err)
    };
    return this;
  };
  return FakeDomain;
})();

var Promise = require('es6-promise').Promise;

var promiseCallback = require('promisecallback');

function onerror(error) {
  this._transactionError = error;
}

function TransactionNotExecutedException(message) {
  TransactionNotExecutedException.super_.call(this, message);
};
inherits(TransactionNotExecutedException, Error);

function TransactionNotCommitedException(message) {
  TransactionNotCommitedException.super_.call(this, message);
};
inherits(TransactionNotCommitedException, TransactionNotExecutedException);

function TransactionRollbackException(message) {
  TransactionRollbackException.super_.call(this, message);
};
inherits(TransactionRollbackException, TransactionNotExecutedException);

function Transaction(commit) {
  Transaction.super_.call(this);

  var operations = [];

  Object.defineProperty(this, 'length', {
    get: function () {
      return operations.length
    }
  });

  this.push = operations.push.bind(operations);

  Object.defineProperty(this, 'commited', {
    configurable: true,
    value: false
  });

  this.commit = function (callback) {
    if (this.exit) this.exit();
    this.removeListener('error', onerror);

    var promise;

    if (this._transactionError)
      promise = Promise.reject(this._transactionError)

    else {
      operations.forEach(function (operation) {
        var object = operation.params.object;
        if (object && object.transactions) {
          object.transactions.shift();

          if (!object.transactions)
            delete object.transactions;
        }
      });

      var self = this;

      promise = new Promise(function (resolve, reject) {
        function callback(error, result) {
          Object.defineProperty(self, 'commited', {
            value: error == undefined
          });

          if (error) return reject(error);

          resolve(result)
        }

        commit(operations, callback);
      })
    }

    promise = promiseCallback(promise, callback)

    this.catch = promise.catch.bind(promise);
    this.then = promise.then.bind(promise);

    delete this.push;
    delete this.commit;
    delete this.endTransaction;

    return this;
  }

  this.rollback = function (callback) {
    Object.defineProperty(this, 'commited', {
      value: false
    });

    var error = new TransactionRollbackException(
      'Transaction rollback by user');

    // Notify error to all the operations in the transaction
    operations.forEach(function (operation) {
      if (operation.method == 'create')
        operation.params.object.emit('_id', error);

      var callback = operation.callback;
      if (callback instanceof Function)
        callback(error);
    });

    if (callback instanceof Function)
      callback(error);

    return this;
  };

  // Errors during transaction execution go to the callback,
  // user will register 'error' event for async errors later
  this.once('error', onerror);
  if (this.enter) this.enter();
}
inherits(Transaction, Domain);

function TransactionsManager(host, commit) {
  var transactions = [];

  Object.defineProperty(this, 'length', {
    get: function () {
      return transactions.length
    }
  });

  this.beginTransaction = function () {
    var transaction = new Transaction(commit);
    //    transactions.unshift(transaction);
    return transaction;
  };

  this.endTransaction = function (callback) {
    //    return transactions.shift().commit(callback);
  };

  this.transaction = function (func, callback) {
    var transaction = this.beginTransaction();
    transactions.unshift(transaction);

    transaction.run(func.bind(host));

    return transactions.shift().commit(callback);
    //    return this.endTransaction(callback)
  };

  this.push = function (data) {
    transactions[0].push(data);
  }
};

function transactionOperation(method, params, callback) {
  var operation = {
    method: method,
    params: params,
    callback: callback
  }

  var object = params.object;
  if (object)
    if (object.transactions)
      object.transactions.unshift(this)
    else
      Object.defineProperty(object, 'transactions', {
        configurable: true,
        value: [this]
      });

  this.push(operation);
};

module.exports = TransactionsManager;

TransactionsManager.Transaction = Transaction;
TransactionsManager.transactionOperation = transactionOperation;
TransactionsManager.TransactionNotExecutedException =
  TransactionNotExecutedException;
TransactionsManager.TransactionNotCommitedException =
  TransactionNotCommitedException;
TransactionsManager.TransactionRollbackException = TransactionRollbackException;

},{"domain":16,"es6-promise":9,"events":17,"inherits":40,"promisecallback":122}],4:[function(require,module,exports){
/**
 * Loader for the kurento-client package on the browser
 */

if (typeof kurentoClient == 'undefined')
  window.kurentoClient = require('.');

},{".":"kurento-client"}],5:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var Promise = require('es6-promise').Promise;

var async = require('async');

var promiseCallback = require('promisecallback');

function createPromise(data, func, callback) {
  var promise = new Promise(function (resolve, reject) {
    function callback2(error, result) {
      if (error) return reject(error);

      resolve(result);
    };

    if (data instanceof Array)
      async.map(data, func, callback2);
    else
      func(data, callback2);
  });

  return promiseCallback(promise, callback);
};

module.exports = createPromise;

},{"async":7,"es6-promise":9,"promisecallback":122}],6:[function(require,module,exports){
var checkType = require('checktype');

var abstracts = {};
var classes = {};
var complexTypes = {};
var modules = [];

function registerAbstracts(classes) {
  for (var name in classes) {
    var constructor = classes[name]

    // Register constructor checker
    var check = constructor.check;
    if (check) checkType[name] = check;

    // Register constructor
    abstracts[name] = constructor;
  }
}

function registerClass(name, constructor) {
  // Register constructor checker
  var check = constructor.check;
  if (check) checkType[name] = check;

  // Register constructor
  classes[name] = constructor;
}

function registerComplexTypes(types) {
  for (var name in types) {
    var constructor = types[name]

    // Register constructor checker
    var check = constructor.check;
    if (check) {
      checkType[name] = check;

      // Register constructor
      complexTypes[name] = constructor;
    } else
      checkType[name] = constructor;
  }
}

function registerModule(name) {
  modules.push(name)
  modules.sort()
}

function register(name, constructor) {
  // Adjust parameters
  if (typeof name != 'string') {
    constructor = name
    name = undefined
  } else if (constructor == undefined) {
    // Execute require if we only have a name
    return register(name, require(name));
  }

  // Registering a function
  if (constructor instanceof Function) {
    // Registration name
    if (!name) name = constructor.name

    if (name == undefined)
      throw new Error("Can't register an anonymous module");

    registerClass(name, constructor)
  }

  // Registering a plugin
  else {
    if (!name) name = constructor.name

    if (name) registerModule(name)

    for (var key in constructor) {
      var value = constructor[key]

      if (typeof value === 'string') continue

      switch (key) {
      case 'abstracts':
        registerAbstracts(value)
        break

      case 'complexTypes':
        registerComplexTypes(value)
        break

      default:
        registerClass(key, value)
      }
    }
  }
};

module.exports = register;

register.abstracts = abstracts;
register.classes = classes;
register.complexTypes = complexTypes;
register.modules = modules;

},{"checktype":8}],7:[function(require,module,exports){
(function (process){
/*!
 * async
 * https://github.com/caolan/async
 *
 * Copyright 2010-2014 Caolan McMahon
 * Released under the MIT license
 */
/*jshint onevar: false, indent:4 */
/*global setImmediate: false, setTimeout: false, console: false */
(function () {

    var async = {};

    // global on the server, window in the browser
    var root, previous_async;

    root = this;
    if (root != null) {
      previous_async = root.async;
    }

    async.noConflict = function () {
        root.async = previous_async;
        return async;
    };

    function only_once(fn) {
        var called = false;
        return function() {
            if (called) throw new Error("Callback was already called.");
            called = true;
            fn.apply(root, arguments);
        }
    }

    //// cross-browser compatiblity functions ////

    var _toString = Object.prototype.toString;

    var _isArray = Array.isArray || function (obj) {
        return _toString.call(obj) === '[object Array]';
    };

    var _each = function (arr, iterator) {
        if (arr.forEach) {
            return arr.forEach(iterator);
        }
        for (var i = 0; i < arr.length; i += 1) {
            iterator(arr[i], i, arr);
        }
    };

    var _map = function (arr, iterator) {
        if (arr.map) {
            return arr.map(iterator);
        }
        var results = [];
        _each(arr, function (x, i, a) {
            results.push(iterator(x, i, a));
        });
        return results;
    };

    var _reduce = function (arr, iterator, memo) {
        if (arr.reduce) {
            return arr.reduce(iterator, memo);
        }
        _each(arr, function (x, i, a) {
            memo = iterator(memo, x, i, a);
        });
        return memo;
    };

    var _keys = function (obj) {
        if (Object.keys) {
            return Object.keys(obj);
        }
        var keys = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                keys.push(k);
            }
        }
        return keys;
    };

    //// exported async module functions ////

    //// nextTick implementation with browser-compatible fallback ////
    if (typeof process === 'undefined' || !(process.nextTick)) {
        if (typeof setImmediate === 'function') {
            async.nextTick = function (fn) {
                // not a direct alias for IE10 compatibility
                setImmediate(fn);
            };
            async.setImmediate = async.nextTick;
        }
        else {
            async.nextTick = function (fn) {
                setTimeout(fn, 0);
            };
            async.setImmediate = async.nextTick;
        }
    }
    else {
        async.nextTick = process.nextTick;
        if (typeof setImmediate !== 'undefined') {
            async.setImmediate = function (fn) {
              // not a direct alias for IE10 compatibility
              setImmediate(fn);
            };
        }
        else {
            async.setImmediate = async.nextTick;
        }
    }

    async.each = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        _each(arr, function (x) {
            iterator(x, only_once(done) );
        });
        function done(err) {
          if (err) {
              callback(err);
              callback = function () {};
          }
          else {
              completed += 1;
              if (completed >= arr.length) {
                  callback();
              }
          }
        }
    };
    async.forEach = async.each;

    async.eachSeries = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        var iterate = function () {
            iterator(arr[completed], function (err) {
                if (err) {
                    callback(err);
                    callback = function () {};
                }
                else {
                    completed += 1;
                    if (completed >= arr.length) {
                        callback();
                    }
                    else {
                        iterate();
                    }
                }
            });
        };
        iterate();
    };
    async.forEachSeries = async.eachSeries;

    async.eachLimit = function (arr, limit, iterator, callback) {
        var fn = _eachLimit(limit);
        fn.apply(null, [arr, iterator, callback]);
    };
    async.forEachLimit = async.eachLimit;

    var _eachLimit = function (limit) {

        return function (arr, iterator, callback) {
            callback = callback || function () {};
            if (!arr.length || limit <= 0) {
                return callback();
            }
            var completed = 0;
            var started = 0;
            var running = 0;

            (function replenish () {
                if (completed >= arr.length) {
                    return callback();
                }

                while (running < limit && started < arr.length) {
                    started += 1;
                    running += 1;
                    iterator(arr[started - 1], function (err) {
                        if (err) {
                            callback(err);
                            callback = function () {};
                        }
                        else {
                            completed += 1;
                            running -= 1;
                            if (completed >= arr.length) {
                                callback();
                            }
                            else {
                                replenish();
                            }
                        }
                    });
                }
            })();
        };
    };


    var doParallel = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.each].concat(args));
        };
    };
    var doParallelLimit = function(limit, fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [_eachLimit(limit)].concat(args));
        };
    };
    var doSeries = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.eachSeries].concat(args));
        };
    };


    var _asyncMap = function (eachfn, arr, iterator, callback) {
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        if (!callback) {
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err) {
                    callback(err);
                });
            });
        } else {
            var results = [];
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err, v) {
                    results[x.index] = v;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };
    async.map = doParallel(_asyncMap);
    async.mapSeries = doSeries(_asyncMap);
    async.mapLimit = function (arr, limit, iterator, callback) {
        return _mapLimit(limit)(arr, iterator, callback);
    };

    var _mapLimit = function(limit) {
        return doParallelLimit(limit, _asyncMap);
    };

    // reduce only has a series version, as doing reduce in parallel won't
    // work in many situations.
    async.reduce = function (arr, memo, iterator, callback) {
        async.eachSeries(arr, function (x, callback) {
            iterator(memo, x, function (err, v) {
                memo = v;
                callback(err);
            });
        }, function (err) {
            callback(err, memo);
        });
    };
    // inject alias
    async.inject = async.reduce;
    // foldl alias
    async.foldl = async.reduce;

    async.reduceRight = function (arr, memo, iterator, callback) {
        var reversed = _map(arr, function (x) {
            return x;
        }).reverse();
        async.reduce(reversed, memo, iterator, callback);
    };
    // foldr alias
    async.foldr = async.reduceRight;

    var _filter = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.filter = doParallel(_filter);
    async.filterSeries = doSeries(_filter);
    // select alias
    async.select = async.filter;
    async.selectSeries = async.filterSeries;

    var _reject = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (!v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.reject = doParallel(_reject);
    async.rejectSeries = doSeries(_reject);

    var _detect = function (eachfn, arr, iterator, main_callback) {
        eachfn(arr, function (x, callback) {
            iterator(x, function (result) {
                if (result) {
                    main_callback(x);
                    main_callback = function () {};
                }
                else {
                    callback();
                }
            });
        }, function (err) {
            main_callback();
        });
    };
    async.detect = doParallel(_detect);
    async.detectSeries = doSeries(_detect);

    async.some = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (v) {
                    main_callback(true);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(false);
        });
    };
    // any alias
    async.any = async.some;

    async.every = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (!v) {
                    main_callback(false);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(true);
        });
    };
    // all alias
    async.all = async.every;

    async.sortBy = function (arr, iterator, callback) {
        async.map(arr, function (x, callback) {
            iterator(x, function (err, criteria) {
                if (err) {
                    callback(err);
                }
                else {
                    callback(null, {value: x, criteria: criteria});
                }
            });
        }, function (err, results) {
            if (err) {
                return callback(err);
            }
            else {
                var fn = function (left, right) {
                    var a = left.criteria, b = right.criteria;
                    return a < b ? -1 : a > b ? 1 : 0;
                };
                callback(null, _map(results.sort(fn), function (x) {
                    return x.value;
                }));
            }
        });
    };

    async.auto = function (tasks, callback) {
        callback = callback || function () {};
        var keys = _keys(tasks);
        var remainingTasks = keys.length
        if (!remainingTasks) {
            return callback();
        }

        var results = {};

        var listeners = [];
        var addListener = function (fn) {
            listeners.unshift(fn);
        };
        var removeListener = function (fn) {
            for (var i = 0; i < listeners.length; i += 1) {
                if (listeners[i] === fn) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        };
        var taskComplete = function () {
            remainingTasks--
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (!remainingTasks) {
                var theCallback = callback;
                // prevent final callback from calling itself if it errors
                callback = function () {};

                theCallback(null, results);
            }
        });

        _each(keys, function (k) {
            var task = _isArray(tasks[k]) ? tasks[k]: [tasks[k]];
            var taskCallback = function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (args.length <= 1) {
                    args = args[0];
                }
                if (err) {
                    var safeResults = {};
                    _each(_keys(results), function(rkey) {
                        safeResults[rkey] = results[rkey];
                    });
                    safeResults[k] = args;
                    callback(err, safeResults);
                    // stop subsequent errors hitting callback multiple times
                    callback = function () {};
                }
                else {
                    results[k] = args;
                    async.setImmediate(taskComplete);
                }
            };
            var requires = task.slice(0, Math.abs(task.length - 1)) || [];
            var ready = function () {
                return _reduce(requires, function (a, x) {
                    return (a && results.hasOwnProperty(x));
                }, true) && !results.hasOwnProperty(k);
            };
            if (ready()) {
                task[task.length - 1](taskCallback, results);
            }
            else {
                var listener = function () {
                    if (ready()) {
                        removeListener(listener);
                        task[task.length - 1](taskCallback, results);
                    }
                };
                addListener(listener);
            }
        });
    };

    async.retry = function(times, task, callback) {
        var DEFAULT_TIMES = 5;
        var attempts = [];
        // Use defaults if times not passed
        if (typeof times === 'function') {
            callback = task;
            task = times;
            times = DEFAULT_TIMES;
        }
        // Make sure times is a number
        times = parseInt(times, 10) || DEFAULT_TIMES;
        var wrappedTask = function(wrappedCallback, wrappedResults) {
            var retryAttempt = function(task, finalAttempt) {
                return function(seriesCallback) {
                    task(function(err, result){
                        seriesCallback(!err || finalAttempt, {err: err, result: result});
                    }, wrappedResults);
                };
            };
            while (times) {
                attempts.push(retryAttempt(task, !(times-=1)));
            }
            async.series(attempts, function(done, data){
                data = data[data.length - 1];
                (wrappedCallback || callback)(data.err, data.result);
            });
        }
        // If a callback is passed, run this as a controll flow
        return callback ? wrappedTask() : wrappedTask
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (!_isArray(tasks)) {
          var err = new Error('First argument to waterfall must be an array of functions');
          return callback(err);
        }
        if (!tasks.length) {
            return callback();
        }
        var wrapIterator = function (iterator) {
            return function (err) {
                if (err) {
                    callback.apply(null, arguments);
                    callback = function () {};
                }
                else {
                    var args = Array.prototype.slice.call(arguments, 1);
                    var next = iterator.next();
                    if (next) {
                        args.push(wrapIterator(next));
                    }
                    else {
                        args.push(callback);
                    }
                    async.setImmediate(function () {
                        iterator.apply(null, args);
                    });
                }
            };
        };
        wrapIterator(async.iterator(tasks))();
    };

    var _parallel = function(eachfn, tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            eachfn.map(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            eachfn.each(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.parallel = function (tasks, callback) {
        _parallel({ map: async.map, each: async.each }, tasks, callback);
    };

    async.parallelLimit = function(tasks, limit, callback) {
        _parallel({ map: _mapLimit(limit), each: _eachLimit(limit) }, tasks, callback);
    };

    async.series = function (tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            async.mapSeries(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            async.eachSeries(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.iterator = function (tasks) {
        var makeCallback = function (index) {
            var fn = function () {
                if (tasks.length) {
                    tasks[index].apply(null, arguments);
                }
                return fn.next();
            };
            fn.next = function () {
                return (index < tasks.length - 1) ? makeCallback(index + 1): null;
            };
            return fn;
        };
        return makeCallback(0);
    };

    async.apply = function (fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return function () {
            return fn.apply(
                null, args.concat(Array.prototype.slice.call(arguments))
            );
        };
    };

    var _concat = function (eachfn, arr, fn, callback) {
        var r = [];
        eachfn(arr, function (x, cb) {
            fn(x, function (err, y) {
                r = r.concat(y || []);
                cb(err);
            });
        }, function (err) {
            callback(err, r);
        });
    };
    async.concat = doParallel(_concat);
    async.concatSeries = doSeries(_concat);

    async.whilst = function (test, iterator, callback) {
        if (test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.whilst(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doWhilst = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (test.apply(null, args)) {
                async.doWhilst(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.until = function (test, iterator, callback) {
        if (!test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.until(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doUntil = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (!test.apply(null, args)) {
                async.doUntil(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.queue = function (worker, concurrency) {
        if (concurrency === undefined) {
            concurrency = 1;
        }
        function _insert(q, data, pos, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  callback: typeof callback === 'function' ? callback : null
              };

              if (pos) {
                q.tasks.unshift(item);
              } else {
                q.tasks.push(item);
              }

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }

        var workers = 0;
        var q = {
            tasks: [],
            concurrency: concurrency,
            saturated: null,
            empty: null,
            drain: null,
            started: false,
            paused: false,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            kill: function () {
              q.drain = null;
              q.tasks = [];
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (!q.paused && workers < q.concurrency && q.tasks.length) {
                    var task = q.tasks.shift();
                    if (q.empty && q.tasks.length === 0) {
                        q.empty();
                    }
                    workers += 1;
                    var next = function () {
                        workers -= 1;
                        if (task.callback) {
                            task.callback.apply(task, arguments);
                        }
                        if (q.drain && q.tasks.length + workers === 0) {
                            q.drain();
                        }
                        q.process();
                    };
                    var cb = only_once(next);
                    worker(task.data, cb);
                }
            },
            length: function () {
                return q.tasks.length;
            },
            running: function () {
                return workers;
            },
            idle: function() {
                return q.tasks.length + workers === 0;
            },
            pause: function () {
                if (q.paused === true) { return; }
                q.paused = true;
                q.process();
            },
            resume: function () {
                if (q.paused === false) { return; }
                q.paused = false;
                q.process();
            }
        };
        return q;
    };

    async.priorityQueue = function (worker, concurrency) {

        function _compareTasks(a, b){
          return a.priority - b.priority;
        };

        function _binarySearch(sequence, item, compare) {
          var beg = -1,
              end = sequence.length - 1;
          while (beg < end) {
            var mid = beg + ((end - beg + 1) >>> 1);
            if (compare(item, sequence[mid]) >= 0) {
              beg = mid;
            } else {
              end = mid - 1;
            }
          }
          return beg;
        }

        function _insert(q, data, priority, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  priority: priority,
                  callback: typeof callback === 'function' ? callback : null
              };

              q.tasks.splice(_binarySearch(q.tasks, item, _compareTasks) + 1, 0, item);

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }

        // Start with a normal queue
        var q = async.queue(worker, concurrency);

        // Override push to accept second parameter representing priority
        q.push = function (data, priority, callback) {
          _insert(q, data, priority, callback);
        };

        // Remove unshift function
        delete q.unshift;

        return q;
    };

    async.cargo = function (worker, payload) {
        var working     = false,
            tasks       = [];

        var cargo = {
            tasks: tasks,
            payload: payload,
            saturated: null,
            empty: null,
            drain: null,
            drained: true,
            push: function (data, callback) {
                if (!_isArray(data)) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    cargo.drained = false;
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain && !cargo.drained) cargo.drain();
                    cargo.drained = true;
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0, tasks.length);

                var ds = _map(ts, function (task) {
                    return task.data;
                });

                if(cargo.empty) cargo.empty();
                working = true;
                worker(ds, function () {
                    working = false;

                    var args = arguments;
                    _each(ts, function (data) {
                        if (data.callback) {
                            data.callback.apply(null, args);
                        }
                    });

                    process();
                });
            },
            length: function () {
                return tasks.length;
            },
            running: function () {
                return working;
            }
        };
        return cargo;
    };

    var _console_fn = function (name) {
        return function (fn) {
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args.concat([function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (typeof console !== 'undefined') {
                    if (err) {
                        if (console.error) {
                            console.error(err);
                        }
                    }
                    else if (console[name]) {
                        _each(args, function (x) {
                            console[name](x);
                        });
                    }
                }
            }]));
        };
    };
    async.log = _console_fn('log');
    async.dir = _console_fn('dir');
    /*async.info = _console_fn('info');
    async.warn = _console_fn('warn');
    async.error = _console_fn('error');*/

    async.memoize = function (fn, hasher) {
        var memo = {};
        var queues = {};
        hasher = hasher || function (x) {
            return x;
        };
        var memoized = function () {
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            var key = hasher.apply(null, args);
            if (key in memo) {
                async.nextTick(function () {
                    callback.apply(null, memo[key]);
                });
            }
            else if (key in queues) {
                queues[key].push(callback);
            }
            else {
                queues[key] = [callback];
                fn.apply(null, args.concat([function () {
                    memo[key] = arguments;
                    var q = queues[key];
                    delete queues[key];
                    for (var i = 0, l = q.length; i < l; i++) {
                      q[i].apply(null, arguments);
                    }
                }]));
            }
        };
        memoized.memo = memo;
        memoized.unmemoized = fn;
        return memoized;
    };

    async.unmemoize = function (fn) {
      return function () {
        return (fn.unmemoized || fn).apply(null, arguments);
      };
    };

    async.times = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.map(counter, iterator, callback);
    };

    async.timesSeries = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.mapSeries(counter, iterator, callback);
    };

    async.seq = function (/* functions... */) {
        var fns = arguments;
        return function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            async.reduce(fns, args, function (newargs, fn, cb) {
                fn.apply(that, newargs.concat([function () {
                    var err = arguments[0];
                    var nextargs = Array.prototype.slice.call(arguments, 1);
                    cb(err, nextargs);
                }]))
            },
            function (err, results) {
                callback.apply(that, [err].concat(results));
            });
        };
    };

    async.compose = function (/* functions... */) {
      return async.seq.apply(null, Array.prototype.reverse.call(arguments));
    };

    var _applyEach = function (eachfn, fns /*args...*/) {
        var go = function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            return eachfn(fns, function (fn, cb) {
                fn.apply(that, args.concat([cb]));
            },
            callback);
        };
        if (arguments.length > 2) {
            var args = Array.prototype.slice.call(arguments, 2);
            return go.apply(this, args);
        }
        else {
            return go;
        }
    };
    async.applyEach = doParallel(_applyEach);
    async.applyEachSeries = doSeries(_applyEach);

    async.forever = function (fn, callback) {
        function next(err) {
            if (err) {
                if (callback) {
                    return callback(err);
                }
                throw err;
            }
            fn(next);
        }
        next();
    };

    // Node.js
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // AMD / RequireJS
    else if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

}).call(this,require('_process'))
},{"_process":19}],8:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


/**
 * Number.isInteger() polyfill
 * @function external:Number#isInteger
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isInteger Number.isInteger}
 */
if (!Number.isInteger) {
  Number.isInteger = function isInteger (nVal) {
    return typeof nVal === "number" && isFinite(nVal)
        && nVal > -9007199254740992 && nVal < 9007199254740992
        && Math.floor(nVal) === nVal;
  };
}


function ChecktypeError(key, type, value)
{
  return SyntaxError(key + ' param should be a ' + (type.name || type)
                    + ', not ' + value.constructor.name);
}


//
// Basic types
//

function checkArray(type, key, value)
{
  if(!(value instanceof Array))
    throw ChecktypeError(key, 'Array of '+type, value);

  for(var i=0, item; item=value[i]; i++)
    checkType(type, key+'['+i+']', item);
};

function checkBoolean(key, value)
{
  if(typeof value != 'boolean')
    throw ChecktypeError(key, Boolean, value);
};

function checkNumber(key, value)
{
  if(typeof value != 'number')
    throw ChecktypeError(key, Number, value);
};

function checkInteger(key, value)
{
  if(!Number.isInteger(value))
    throw ChecktypeError(key, 'Integer', value);
};

function checkObject(key, value)
{
  if(typeof value != 'object')
    throw ChecktypeError(key, Object, value);
};

function checkString(key, value)
{
  if(typeof value != 'string')
    throw ChecktypeError(key, String, value);
};


// Checker functions

function checkType(type, key, value, options)
{
  options = options || {};

  if(value != undefined)
  {
    if(options.isArray)
      return checkArray(type, key, value);

    var checker = checkType[type];
    if(checker) return checker(key, value);

    console.warn("Could not check "+key+", unknown type "+type);
//    throw TypeError("Could not check "+key+", unknown type "+type);
  }

  else if(options.required)
    throw SyntaxError(key+" param is required");

};

function checkParams(params, scheme, class_name)
{
  var result = {};

  // check MediaObject params
  for(var key in scheme)
  {
    var value = params[key];

    var s = scheme[key];

    var options = {required: s.required, isArray: s.isList};

    checkType(s.type, key, value, options);

    if(value == undefined) continue;

    result[key] = value;
    delete params[key];
  };

  if(Object.keys(params).length)
    console.warn('Unused params for '+class_name+':', params);

  return result;
};

function checkMethodParams(callparams, method_params)
{
  var result = {};

  var index=0, param;
  for(; param=method_params[index]; index++)
  {
    var key = param.name;
    var value = callparams[index];

    var options = {required: param.required, isArray: param.isList};

    checkType(param.type, key, value, options);

    result[key] = value;
  }

  var params = callparams.slice(index);
  if(params.length)
    console.warning('Unused params:', params);

  return result;
};


module.exports = checkType;

checkType.checkParams    = checkParams;
checkType.ChecktypeError = ChecktypeError;


// Basic types

checkType.boolean = checkBoolean;
checkType.double  = checkNumber;
checkType.float   = checkNumber;
checkType.int     = checkInteger;
checkType.Object  = checkObject;
checkType.String  = checkString;

},{}],9:[function(require,module,exports){
(function (process,global){
/*!
 * @overview es6-promise - a tiny implementation of Promises/A+.
 * @copyright Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors (Conversion to ES6 API by Jake Archibald)
 * @license   Licensed under MIT license
 *            See https://raw.githubusercontent.com/jakearchibald/es6-promise/master/LICENSE
 * @version   2.1.0
 */

(function() {
    "use strict";
    function lib$es6$promise$utils$$objectOrFunction(x) {
      return typeof x === 'function' || (typeof x === 'object' && x !== null);
    }

    function lib$es6$promise$utils$$isFunction(x) {
      return typeof x === 'function';
    }

    function lib$es6$promise$utils$$isMaybeThenable(x) {
      return typeof x === 'object' && x !== null;
    }

    var lib$es6$promise$utils$$_isArray;
    if (!Array.isArray) {
      lib$es6$promise$utils$$_isArray = function (x) {
        return Object.prototype.toString.call(x) === '[object Array]';
      };
    } else {
      lib$es6$promise$utils$$_isArray = Array.isArray;
    }

    var lib$es6$promise$utils$$isArray = lib$es6$promise$utils$$_isArray;
    var lib$es6$promise$asap$$len = 0;
    var lib$es6$promise$asap$$toString = {}.toString;
    var lib$es6$promise$asap$$vertxNext;
    function lib$es6$promise$asap$$asap(callback, arg) {
      lib$es6$promise$asap$$queue[lib$es6$promise$asap$$len] = callback;
      lib$es6$promise$asap$$queue[lib$es6$promise$asap$$len + 1] = arg;
      lib$es6$promise$asap$$len += 2;
      if (lib$es6$promise$asap$$len === 2) {
        // If len is 2, that means that we need to schedule an async flush.
        // If additional callbacks are queued before the queue is flushed, they
        // will be processed by this flush that we are scheduling.
        lib$es6$promise$asap$$scheduleFlush();
      }
    }

    var lib$es6$promise$asap$$default = lib$es6$promise$asap$$asap;

    var lib$es6$promise$asap$$browserWindow = (typeof window !== 'undefined') ? window : undefined;
    var lib$es6$promise$asap$$browserGlobal = lib$es6$promise$asap$$browserWindow || {};
    var lib$es6$promise$asap$$BrowserMutationObserver = lib$es6$promise$asap$$browserGlobal.MutationObserver || lib$es6$promise$asap$$browserGlobal.WebKitMutationObserver;
    var lib$es6$promise$asap$$isNode = typeof process !== 'undefined' && {}.toString.call(process) === '[object process]';

    // test for web worker but not in IE10
    var lib$es6$promise$asap$$isWorker = typeof Uint8ClampedArray !== 'undefined' &&
      typeof importScripts !== 'undefined' &&
      typeof MessageChannel !== 'undefined';

    // node
    function lib$es6$promise$asap$$useNextTick() {
      var nextTick = process.nextTick;
      // node version 0.10.x displays a deprecation warning when nextTick is used recursively
      // setImmediate should be used instead instead
      var version = process.versions.node.match(/^(?:(\d+)\.)?(?:(\d+)\.)?(\*|\d+)$/);
      if (Array.isArray(version) && version[1] === '0' && version[2] === '10') {
        nextTick = setImmediate;
      }
      return function() {
        nextTick(lib$es6$promise$asap$$flush);
      };
    }

    // vertx
    function lib$es6$promise$asap$$useVertxTimer() {
      return function() {
        lib$es6$promise$asap$$vertxNext(lib$es6$promise$asap$$flush);
      };
    }

    function lib$es6$promise$asap$$useMutationObserver() {
      var iterations = 0;
      var observer = new lib$es6$promise$asap$$BrowserMutationObserver(lib$es6$promise$asap$$flush);
      var node = document.createTextNode('');
      observer.observe(node, { characterData: true });

      return function() {
        node.data = (iterations = ++iterations % 2);
      };
    }

    // web worker
    function lib$es6$promise$asap$$useMessageChannel() {
      var channel = new MessageChannel();
      channel.port1.onmessage = lib$es6$promise$asap$$flush;
      return function () {
        channel.port2.postMessage(0);
      };
    }

    function lib$es6$promise$asap$$useSetTimeout() {
      return function() {
        setTimeout(lib$es6$promise$asap$$flush, 1);
      };
    }

    var lib$es6$promise$asap$$queue = new Array(1000);
    function lib$es6$promise$asap$$flush() {
      for (var i = 0; i < lib$es6$promise$asap$$len; i+=2) {
        var callback = lib$es6$promise$asap$$queue[i];
        var arg = lib$es6$promise$asap$$queue[i+1];

        callback(arg);

        lib$es6$promise$asap$$queue[i] = undefined;
        lib$es6$promise$asap$$queue[i+1] = undefined;
      }

      lib$es6$promise$asap$$len = 0;
    }

    function lib$es6$promise$asap$$attemptVertex() {
      try {
        var r = require;
        var vertx = r('vertx');
        lib$es6$promise$asap$$vertxNext = vertx.runOnLoop || vertx.runOnContext;
        return lib$es6$promise$asap$$useVertxTimer();
      } catch(e) {
        return lib$es6$promise$asap$$useSetTimeout();
      }
    }

    var lib$es6$promise$asap$$scheduleFlush;
    // Decide what async method to use to triggering processing of queued callbacks:
    if (lib$es6$promise$asap$$isNode) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useNextTick();
    } else if (lib$es6$promise$asap$$BrowserMutationObserver) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useMutationObserver();
    } else if (lib$es6$promise$asap$$isWorker) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useMessageChannel();
    } else if (lib$es6$promise$asap$$browserWindow === undefined && typeof require === 'function') {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$attemptVertex();
    } else {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useSetTimeout();
    }

    function lib$es6$promise$$internal$$noop() {}

    var lib$es6$promise$$internal$$PENDING   = void 0;
    var lib$es6$promise$$internal$$FULFILLED = 1;
    var lib$es6$promise$$internal$$REJECTED  = 2;

    var lib$es6$promise$$internal$$GET_THEN_ERROR = new lib$es6$promise$$internal$$ErrorObject();

    function lib$es6$promise$$internal$$selfFullfillment() {
      return new TypeError("You cannot resolve a promise with itself");
    }

    function lib$es6$promise$$internal$$cannotReturnOwn() {
      return new TypeError('A promises callback cannot return that same promise.');
    }

    function lib$es6$promise$$internal$$getThen(promise) {
      try {
        return promise.then;
      } catch(error) {
        lib$es6$promise$$internal$$GET_THEN_ERROR.error = error;
        return lib$es6$promise$$internal$$GET_THEN_ERROR;
      }
    }

    function lib$es6$promise$$internal$$tryThen(then, value, fulfillmentHandler, rejectionHandler) {
      try {
        then.call(value, fulfillmentHandler, rejectionHandler);
      } catch(e) {
        return e;
      }
    }

    function lib$es6$promise$$internal$$handleForeignThenable(promise, thenable, then) {
       lib$es6$promise$asap$$default(function(promise) {
        var sealed = false;
        var error = lib$es6$promise$$internal$$tryThen(then, thenable, function(value) {
          if (sealed) { return; }
          sealed = true;
          if (thenable !== value) {
            lib$es6$promise$$internal$$resolve(promise, value);
          } else {
            lib$es6$promise$$internal$$fulfill(promise, value);
          }
        }, function(reason) {
          if (sealed) { return; }
          sealed = true;

          lib$es6$promise$$internal$$reject(promise, reason);
        }, 'Settle: ' + (promise._label || ' unknown promise'));

        if (!sealed && error) {
          sealed = true;
          lib$es6$promise$$internal$$reject(promise, error);
        }
      }, promise);
    }

    function lib$es6$promise$$internal$$handleOwnThenable(promise, thenable) {
      if (thenable._state === lib$es6$promise$$internal$$FULFILLED) {
        lib$es6$promise$$internal$$fulfill(promise, thenable._result);
      } else if (promise._state === lib$es6$promise$$internal$$REJECTED) {
        lib$es6$promise$$internal$$reject(promise, thenable._result);
      } else {
        lib$es6$promise$$internal$$subscribe(thenable, undefined, function(value) {
          lib$es6$promise$$internal$$resolve(promise, value);
        }, function(reason) {
          lib$es6$promise$$internal$$reject(promise, reason);
        });
      }
    }

    function lib$es6$promise$$internal$$handleMaybeThenable(promise, maybeThenable) {
      if (maybeThenable.constructor === promise.constructor) {
        lib$es6$promise$$internal$$handleOwnThenable(promise, maybeThenable);
      } else {
        var then = lib$es6$promise$$internal$$getThen(maybeThenable);

        if (then === lib$es6$promise$$internal$$GET_THEN_ERROR) {
          lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$GET_THEN_ERROR.error);
        } else if (then === undefined) {
          lib$es6$promise$$internal$$fulfill(promise, maybeThenable);
        } else if (lib$es6$promise$utils$$isFunction(then)) {
          lib$es6$promise$$internal$$handleForeignThenable(promise, maybeThenable, then);
        } else {
          lib$es6$promise$$internal$$fulfill(promise, maybeThenable);
        }
      }
    }

    function lib$es6$promise$$internal$$resolve(promise, value) {
      if (promise === value) {
        lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$selfFullfillment());
      } else if (lib$es6$promise$utils$$objectOrFunction(value)) {
        lib$es6$promise$$internal$$handleMaybeThenable(promise, value);
      } else {
        lib$es6$promise$$internal$$fulfill(promise, value);
      }
    }

    function lib$es6$promise$$internal$$publishRejection(promise) {
      if (promise._onerror) {
        promise._onerror(promise._result);
      }

      lib$es6$promise$$internal$$publish(promise);
    }

    function lib$es6$promise$$internal$$fulfill(promise, value) {
      if (promise._state !== lib$es6$promise$$internal$$PENDING) { return; }

      promise._result = value;
      promise._state = lib$es6$promise$$internal$$FULFILLED;

      if (promise._subscribers.length !== 0) {
        lib$es6$promise$asap$$default(lib$es6$promise$$internal$$publish, promise);
      }
    }

    function lib$es6$promise$$internal$$reject(promise, reason) {
      if (promise._state !== lib$es6$promise$$internal$$PENDING) { return; }
      promise._state = lib$es6$promise$$internal$$REJECTED;
      promise._result = reason;

      lib$es6$promise$asap$$default(lib$es6$promise$$internal$$publishRejection, promise);
    }

    function lib$es6$promise$$internal$$subscribe(parent, child, onFulfillment, onRejection) {
      var subscribers = parent._subscribers;
      var length = subscribers.length;

      parent._onerror = null;

      subscribers[length] = child;
      subscribers[length + lib$es6$promise$$internal$$FULFILLED] = onFulfillment;
      subscribers[length + lib$es6$promise$$internal$$REJECTED]  = onRejection;

      if (length === 0 && parent._state) {
        lib$es6$promise$asap$$default(lib$es6$promise$$internal$$publish, parent);
      }
    }

    function lib$es6$promise$$internal$$publish(promise) {
      var subscribers = promise._subscribers;
      var settled = promise._state;

      if (subscribers.length === 0) { return; }

      var child, callback, detail = promise._result;

      for (var i = 0; i < subscribers.length; i += 3) {
        child = subscribers[i];
        callback = subscribers[i + settled];

        if (child) {
          lib$es6$promise$$internal$$invokeCallback(settled, child, callback, detail);
        } else {
          callback(detail);
        }
      }

      promise._subscribers.length = 0;
    }

    function lib$es6$promise$$internal$$ErrorObject() {
      this.error = null;
    }

    var lib$es6$promise$$internal$$TRY_CATCH_ERROR = new lib$es6$promise$$internal$$ErrorObject();

    function lib$es6$promise$$internal$$tryCatch(callback, detail) {
      try {
        return callback(detail);
      } catch(e) {
        lib$es6$promise$$internal$$TRY_CATCH_ERROR.error = e;
        return lib$es6$promise$$internal$$TRY_CATCH_ERROR;
      }
    }

    function lib$es6$promise$$internal$$invokeCallback(settled, promise, callback, detail) {
      var hasCallback = lib$es6$promise$utils$$isFunction(callback),
          value, error, succeeded, failed;

      if (hasCallback) {
        value = lib$es6$promise$$internal$$tryCatch(callback, detail);

        if (value === lib$es6$promise$$internal$$TRY_CATCH_ERROR) {
          failed = true;
          error = value.error;
          value = null;
        } else {
          succeeded = true;
        }

        if (promise === value) {
          lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$cannotReturnOwn());
          return;
        }

      } else {
        value = detail;
        succeeded = true;
      }

      if (promise._state !== lib$es6$promise$$internal$$PENDING) {
        // noop
      } else if (hasCallback && succeeded) {
        lib$es6$promise$$internal$$resolve(promise, value);
      } else if (failed) {
        lib$es6$promise$$internal$$reject(promise, error);
      } else if (settled === lib$es6$promise$$internal$$FULFILLED) {
        lib$es6$promise$$internal$$fulfill(promise, value);
      } else if (settled === lib$es6$promise$$internal$$REJECTED) {
        lib$es6$promise$$internal$$reject(promise, value);
      }
    }

    function lib$es6$promise$$internal$$initializePromise(promise, resolver) {
      try {
        resolver(function resolvePromise(value){
          lib$es6$promise$$internal$$resolve(promise, value);
        }, function rejectPromise(reason) {
          lib$es6$promise$$internal$$reject(promise, reason);
        });
      } catch(e) {
        lib$es6$promise$$internal$$reject(promise, e);
      }
    }

    function lib$es6$promise$enumerator$$Enumerator(Constructor, input) {
      var enumerator = this;

      enumerator._instanceConstructor = Constructor;
      enumerator.promise = new Constructor(lib$es6$promise$$internal$$noop);

      if (enumerator._validateInput(input)) {
        enumerator._input     = input;
        enumerator.length     = input.length;
        enumerator._remaining = input.length;

        enumerator._init();

        if (enumerator.length === 0) {
          lib$es6$promise$$internal$$fulfill(enumerator.promise, enumerator._result);
        } else {
          enumerator.length = enumerator.length || 0;
          enumerator._enumerate();
          if (enumerator._remaining === 0) {
            lib$es6$promise$$internal$$fulfill(enumerator.promise, enumerator._result);
          }
        }
      } else {
        lib$es6$promise$$internal$$reject(enumerator.promise, enumerator._validationError());
      }
    }

    lib$es6$promise$enumerator$$Enumerator.prototype._validateInput = function(input) {
      return lib$es6$promise$utils$$isArray(input);
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._validationError = function() {
      return new Error('Array Methods must be provided an Array');
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._init = function() {
      this._result = new Array(this.length);
    };

    var lib$es6$promise$enumerator$$default = lib$es6$promise$enumerator$$Enumerator;

    lib$es6$promise$enumerator$$Enumerator.prototype._enumerate = function() {
      var enumerator = this;

      var length  = enumerator.length;
      var promise = enumerator.promise;
      var input   = enumerator._input;

      for (var i = 0; promise._state === lib$es6$promise$$internal$$PENDING && i < length; i++) {
        enumerator._eachEntry(input[i], i);
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._eachEntry = function(entry, i) {
      var enumerator = this;
      var c = enumerator._instanceConstructor;

      if (lib$es6$promise$utils$$isMaybeThenable(entry)) {
        if (entry.constructor === c && entry._state !== lib$es6$promise$$internal$$PENDING) {
          entry._onerror = null;
          enumerator._settledAt(entry._state, i, entry._result);
        } else {
          enumerator._willSettleAt(c.resolve(entry), i);
        }
      } else {
        enumerator._remaining--;
        enumerator._result[i] = entry;
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._settledAt = function(state, i, value) {
      var enumerator = this;
      var promise = enumerator.promise;

      if (promise._state === lib$es6$promise$$internal$$PENDING) {
        enumerator._remaining--;

        if (state === lib$es6$promise$$internal$$REJECTED) {
          lib$es6$promise$$internal$$reject(promise, value);
        } else {
          enumerator._result[i] = value;
        }
      }

      if (enumerator._remaining === 0) {
        lib$es6$promise$$internal$$fulfill(promise, enumerator._result);
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._willSettleAt = function(promise, i) {
      var enumerator = this;

      lib$es6$promise$$internal$$subscribe(promise, undefined, function(value) {
        enumerator._settledAt(lib$es6$promise$$internal$$FULFILLED, i, value);
      }, function(reason) {
        enumerator._settledAt(lib$es6$promise$$internal$$REJECTED, i, reason);
      });
    };
    function lib$es6$promise$promise$all$$all(entries) {
      return new lib$es6$promise$enumerator$$default(this, entries).promise;
    }
    var lib$es6$promise$promise$all$$default = lib$es6$promise$promise$all$$all;
    function lib$es6$promise$promise$race$$race(entries) {
      /*jshint validthis:true */
      var Constructor = this;

      var promise = new Constructor(lib$es6$promise$$internal$$noop);

      if (!lib$es6$promise$utils$$isArray(entries)) {
        lib$es6$promise$$internal$$reject(promise, new TypeError('You must pass an array to race.'));
        return promise;
      }

      var length = entries.length;

      function onFulfillment(value) {
        lib$es6$promise$$internal$$resolve(promise, value);
      }

      function onRejection(reason) {
        lib$es6$promise$$internal$$reject(promise, reason);
      }

      for (var i = 0; promise._state === lib$es6$promise$$internal$$PENDING && i < length; i++) {
        lib$es6$promise$$internal$$subscribe(Constructor.resolve(entries[i]), undefined, onFulfillment, onRejection);
      }

      return promise;
    }
    var lib$es6$promise$promise$race$$default = lib$es6$promise$promise$race$$race;
    function lib$es6$promise$promise$resolve$$resolve(object) {
      /*jshint validthis:true */
      var Constructor = this;

      if (object && typeof object === 'object' && object.constructor === Constructor) {
        return object;
      }

      var promise = new Constructor(lib$es6$promise$$internal$$noop);
      lib$es6$promise$$internal$$resolve(promise, object);
      return promise;
    }
    var lib$es6$promise$promise$resolve$$default = lib$es6$promise$promise$resolve$$resolve;
    function lib$es6$promise$promise$reject$$reject(reason) {
      /*jshint validthis:true */
      var Constructor = this;
      var promise = new Constructor(lib$es6$promise$$internal$$noop);
      lib$es6$promise$$internal$$reject(promise, reason);
      return promise;
    }
    var lib$es6$promise$promise$reject$$default = lib$es6$promise$promise$reject$$reject;

    var lib$es6$promise$promise$$counter = 0;

    function lib$es6$promise$promise$$needsResolver() {
      throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
    }

    function lib$es6$promise$promise$$needsNew() {
      throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
    }

    var lib$es6$promise$promise$$default = lib$es6$promise$promise$$Promise;
    /**
      Promise objects represent the eventual result of an asynchronous operation. The
      primary way of interacting with a promise is through its `then` method, which
      registers callbacks to receive either a promise’s eventual value or the reason
      why the promise cannot be fulfilled.

      Terminology
      -----------

      - `promise` is an object or function with a `then` method whose behavior conforms to this specification.
      - `thenable` is an object or function that defines a `then` method.
      - `value` is any legal JavaScript value (including undefined, a thenable, or a promise).
      - `exception` is a value that is thrown using the throw statement.
      - `reason` is a value that indicates why a promise was rejected.
      - `settled` the final resting state of a promise, fulfilled or rejected.

      A promise can be in one of three states: pending, fulfilled, or rejected.

      Promises that are fulfilled have a fulfillment value and are in the fulfilled
      state.  Promises that are rejected have a rejection reason and are in the
      rejected state.  A fulfillment value is never a thenable.

      Promises can also be said to *resolve* a value.  If this value is also a
      promise, then the original promise's settled state will match the value's
      settled state.  So a promise that *resolves* a promise that rejects will
      itself reject, and a promise that *resolves* a promise that fulfills will
      itself fulfill.


      Basic Usage:
      ------------

      ```js
      var promise = new Promise(function(resolve, reject) {
        // on success
        resolve(value);

        // on failure
        reject(reason);
      });

      promise.then(function(value) {
        // on fulfillment
      }, function(reason) {
        // on rejection
      });
      ```

      Advanced Usage:
      ---------------

      Promises shine when abstracting away asynchronous interactions such as
      `XMLHttpRequest`s.

      ```js
      function getJSON(url) {
        return new Promise(function(resolve, reject){
          var xhr = new XMLHttpRequest();

          xhr.open('GET', url);
          xhr.onreadystatechange = handler;
          xhr.responseType = 'json';
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.send();

          function handler() {
            if (this.readyState === this.DONE) {
              if (this.status === 200) {
                resolve(this.response);
              } else {
                reject(new Error('getJSON: `' + url + '` failed with status: [' + this.status + ']'));
              }
            }
          };
        });
      }

      getJSON('/posts.json').then(function(json) {
        // on fulfillment
      }, function(reason) {
        // on rejection
      });
      ```

      Unlike callbacks, promises are great composable primitives.

      ```js
      Promise.all([
        getJSON('/posts'),
        getJSON('/comments')
      ]).then(function(values){
        values[0] // => postsJSON
        values[1] // => commentsJSON

        return values;
      });
      ```

      @class Promise
      @param {function} resolver
      Useful for tooling.
      @constructor
    */
    function lib$es6$promise$promise$$Promise(resolver) {
      this._id = lib$es6$promise$promise$$counter++;
      this._state = undefined;
      this._result = undefined;
      this._subscribers = [];

      if (lib$es6$promise$$internal$$noop !== resolver) {
        if (!lib$es6$promise$utils$$isFunction(resolver)) {
          lib$es6$promise$promise$$needsResolver();
        }

        if (!(this instanceof lib$es6$promise$promise$$Promise)) {
          lib$es6$promise$promise$$needsNew();
        }

        lib$es6$promise$$internal$$initializePromise(this, resolver);
      }
    }

    lib$es6$promise$promise$$Promise.all = lib$es6$promise$promise$all$$default;
    lib$es6$promise$promise$$Promise.race = lib$es6$promise$promise$race$$default;
    lib$es6$promise$promise$$Promise.resolve = lib$es6$promise$promise$resolve$$default;
    lib$es6$promise$promise$$Promise.reject = lib$es6$promise$promise$reject$$default;

    lib$es6$promise$promise$$Promise.prototype = {
      constructor: lib$es6$promise$promise$$Promise,

    /**
      The primary way of interacting with a promise is through its `then` method,
      which registers callbacks to receive either a promise's eventual value or the
      reason why the promise cannot be fulfilled.

      ```js
      findUser().then(function(user){
        // user is available
      }, function(reason){
        // user is unavailable, and you are given the reason why
      });
      ```

      Chaining
      --------

      The return value of `then` is itself a promise.  This second, 'downstream'
      promise is resolved with the return value of the first promise's fulfillment
      or rejection handler, or rejected if the handler throws an exception.

      ```js
      findUser().then(function (user) {
        return user.name;
      }, function (reason) {
        return 'default name';
      }).then(function (userName) {
        // If `findUser` fulfilled, `userName` will be the user's name, otherwise it
        // will be `'default name'`
      });

      findUser().then(function (user) {
        throw new Error('Found user, but still unhappy');
      }, function (reason) {
        throw new Error('`findUser` rejected and we're unhappy');
      }).then(function (value) {
        // never reached
      }, function (reason) {
        // if `findUser` fulfilled, `reason` will be 'Found user, but still unhappy'.
        // If `findUser` rejected, `reason` will be '`findUser` rejected and we're unhappy'.
      });
      ```
      If the downstream promise does not specify a rejection handler, rejection reasons will be propagated further downstream.

      ```js
      findUser().then(function (user) {
        throw new PedagogicalException('Upstream error');
      }).then(function (value) {
        // never reached
      }).then(function (value) {
        // never reached
      }, function (reason) {
        // The `PedgagocialException` is propagated all the way down to here
      });
      ```

      Assimilation
      ------------

      Sometimes the value you want to propagate to a downstream promise can only be
      retrieved asynchronously. This can be achieved by returning a promise in the
      fulfillment or rejection handler. The downstream promise will then be pending
      until the returned promise is settled. This is called *assimilation*.

      ```js
      findUser().then(function (user) {
        return findCommentsByAuthor(user);
      }).then(function (comments) {
        // The user's comments are now available
      });
      ```

      If the assimliated promise rejects, then the downstream promise will also reject.

      ```js
      findUser().then(function (user) {
        return findCommentsByAuthor(user);
      }).then(function (comments) {
        // If `findCommentsByAuthor` fulfills, we'll have the value here
      }, function (reason) {
        // If `findCommentsByAuthor` rejects, we'll have the reason here
      });
      ```

      Simple Example
      --------------

      Synchronous Example

      ```javascript
      var result;

      try {
        result = findResult();
        // success
      } catch(reason) {
        // failure
      }
      ```

      Errback Example

      ```js
      findResult(function(result, err){
        if (err) {
          // failure
        } else {
          // success
        }
      });
      ```

      Promise Example;

      ```javascript
      findResult().then(function(result){
        // success
      }, function(reason){
        // failure
      });
      ```

      Advanced Example
      --------------

      Synchronous Example

      ```javascript
      var author, books;

      try {
        author = findAuthor();
        books  = findBooksByAuthor(author);
        // success
      } catch(reason) {
        // failure
      }
      ```

      Errback Example

      ```js

      function foundBooks(books) {

      }

      function failure(reason) {

      }

      findAuthor(function(author, err){
        if (err) {
          failure(err);
          // failure
        } else {
          try {
            findBoooksByAuthor(author, function(books, err) {
              if (err) {
                failure(err);
              } else {
                try {
                  foundBooks(books);
                } catch(reason) {
                  failure(reason);
                }
              }
            });
          } catch(error) {
            failure(err);
          }
          // success
        }
      });
      ```

      Promise Example;

      ```javascript
      findAuthor().
        then(findBooksByAuthor).
        then(function(books){
          // found books
      }).catch(function(reason){
        // something went wrong
      });
      ```

      @method then
      @param {Function} onFulfilled
      @param {Function} onRejected
      Useful for tooling.
      @return {Promise}
    */
      then: function(onFulfillment, onRejection) {
        var parent = this;
        var state = parent._state;

        if (state === lib$es6$promise$$internal$$FULFILLED && !onFulfillment || state === lib$es6$promise$$internal$$REJECTED && !onRejection) {
          return this;
        }

        var child = new this.constructor(lib$es6$promise$$internal$$noop);
        var result = parent._result;

        if (state) {
          var callback = arguments[state - 1];
          lib$es6$promise$asap$$default(function(){
            lib$es6$promise$$internal$$invokeCallback(state, child, callback, result);
          });
        } else {
          lib$es6$promise$$internal$$subscribe(parent, child, onFulfillment, onRejection);
        }

        return child;
      },

    /**
      `catch` is simply sugar for `then(undefined, onRejection)` which makes it the same
      as the catch block of a try/catch statement.

      ```js
      function findAuthor(){
        throw new Error('couldn't find that author');
      }

      // synchronous
      try {
        findAuthor();
      } catch(reason) {
        // something went wrong
      }

      // async with promises
      findAuthor().catch(function(reason){
        // something went wrong
      });
      ```

      @method catch
      @param {Function} onRejection
      Useful for tooling.
      @return {Promise}
    */
      'catch': function(onRejection) {
        return this.then(null, onRejection);
      }
    };
    function lib$es6$promise$polyfill$$polyfill() {
      var local;

      if (typeof global !== 'undefined') {
          local = global;
      } else if (typeof self !== 'undefined') {
          local = self;
      } else {
          try {
              local = Function('return this')();
          } catch (e) {
              throw new Error('polyfill failed because global object is unavailable in this environment');
          }
      }

      var P = local.Promise;

      if (P && Object.prototype.toString.call(P.resolve()) === '[object Promise]' && !P.cast) {
        return;
      }

      local.Promise = lib$es6$promise$promise$$default;
    }
    var lib$es6$promise$polyfill$$default = lib$es6$promise$polyfill$$polyfill;

    var lib$es6$promise$umd$$ES6Promise = {
      'Promise': lib$es6$promise$promise$$default,
      'polyfill': lib$es6$promise$polyfill$$default
    };

    /* global define:true module:true window: true */
    if (typeof define === 'function' && define['amd']) {
      define(function() { return lib$es6$promise$umd$$ES6Promise; });
    } else if (typeof module !== 'undefined' && module['exports']) {
      module['exports'] = lib$es6$promise$umd$$ES6Promise;
    } else if (typeof this !== 'undefined') {
      this['ES6Promise'] = lib$es6$promise$umd$$ES6Promise;
    }

    lib$es6$promise$polyfill$$default();
}).call(this);


}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"_process":19}],10:[function(require,module,exports){
var hasOwn = Object.prototype.hasOwnProperty;
var toString = Object.prototype.toString;
var undefined;

var isPlainObject = function isPlainObject(obj) {
	'use strict';
	if (!obj || toString.call(obj) !== '[object Object]') {
		return false;
	}

	var has_own_constructor = hasOwn.call(obj, 'constructor');
	var has_is_property_of_method = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, 'isPrototypeOf');
	// Not own constructor property must be Object
	if (obj.constructor && !has_own_constructor && !has_is_property_of_method) {
		return false;
	}

	// Own properties are enumerated firstly, so to speed up,
	// if last one is own, then all properties are own.
	var key;
	for (key in obj) {}

	return key === undefined || hasOwn.call(obj, key);
};

module.exports = function extend() {
	'use strict';
	var options, name, src, copy, copyIsArray, clone,
		target = arguments[0],
		i = 1,
		length = arguments.length,
		deep = false;

	// Handle a deep copy situation
	if (typeof target === 'boolean') {
		deep = target;
		target = arguments[1] || {};
		// skip the boolean and the target
		i = 2;
	} else if ((typeof target !== 'object' && typeof target !== 'function') || target == null) {
		target = {};
	}

	for (; i < length; ++i) {
		options = arguments[i];
		// Only deal with non-null/undefined values
		if (options != null) {
			// Extend the base object
			for (name in options) {
				src = target[name];
				copy = options[name];

				// Prevent never-ending loop
				if (target === copy) {
					continue;
				}

				// Recurse if we're merging plain objects or arrays
				if (deep && copy && (isPlainObject(copy) || (copyIsArray = Array.isArray(copy)))) {
					if (copyIsArray) {
						copyIsArray = false;
						clone = src && Array.isArray(src) ? src : [];
					} else {
						clone = src && isPlainObject(src) ? src : {};
					}

					// Never move original objects, clone them
					target[name] = extend(deep, clone, copy);

				// Don't bring in undefined values
				} else if (copy !== undefined) {
					target[name] = copy;
				}
			}
		}
	}

	// Return the modified object
	return target;
};


},{}],11:[function(require,module,exports){

},{}],12:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var kMaxLength = 0x3fffffff
var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Note:
 *
 * - Implementation must support adding new properties to `Uint8Array` instances.
 *   Firefox 4-29 lacked support, fixed in Firefox 30+.
 *   See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *  - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *  - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *    incorrect length in some situations.
 *
 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they will
 * get the Object implementation, which is slower but will work correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = (function () {
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        new Uint8Array(1).subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding) {
  var self = this
  if (!(self instanceof Buffer)) return new Buffer(subject, encoding)

  var type = typeof subject
  var length

  if (type === 'number') {
    length = +subject
  } else if (type === 'string') {
    length = Buffer.byteLength(subject, encoding)
  } else if (type === 'object' && subject !== null) {
    // assume object is array-like
    if (subject.type === 'Buffer' && isArray(subject.data)) subject = subject.data
    length = +subject.length
  } else {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (length > kMaxLength) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum size: 0x' +
      kMaxLength.toString(16) + ' bytes')
  }

  if (length < 0) length = 0
  else length >>>= 0 // coerce to uint32

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    self = Buffer._augment(new Uint8Array(length)) // eslint-disable-line consistent-this
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    self.length = length
    self._isBuffer = true
  }

  var i
  if (Buffer.TYPED_ARRAY_SUPPORT && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    self._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++) {
        self[i] = subject.readUInt8(i)
      }
    } else {
      for (i = 0; i < length; i++) {
        self[i] = ((subject[i] % 256) + 256) % 256
      }
    }
  } else if (type === 'string') {
    self.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer.TYPED_ARRAY_SUPPORT) {
    for (i = 0; i < length; i++) {
      self[i] = 0
    }
  }

  if (length > 0 && length <= Buffer.poolSize) self.parent = rootParent

  return self
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, totalLength) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.byteLength = function byteLength (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    case 'hex':
      ret = str.length >>> 1
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    default:
      ret = str.length
  }
  return ret
}

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

// toString(encoding, start=0, end=buffer.length)
Buffer.prototype.toString = function toString (encoding, start, end) {
  var loweredCase = false

  start = start >>> 0
  end = end === undefined || end === Infinity ? this.length : end >>> 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function get (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function set (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0

  if (length < 0 || offset < 0 || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new TypeError('Unknown encoding: ' + encoding)
  }
  return ret
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) >>> 0 & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) >>> 0 & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = value
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = value
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkInt(
      this, value, offset, byteLength,
      Math.pow(2, 8 * byteLength - 1) - 1,
      -Math.pow(2, 8 * byteLength - 1)
    )
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkInt(
      this, value, offset, byteLength,
      Math.pow(2, 8 * byteLength - 1) - 1,
      -Math.pow(2, 8 * byteLength - 1)
    )
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = value
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, target_start, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (target_start >= target.length) target_start = target.length
  if (!target_start) target_start = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (target_start < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - target_start < end - start) {
    end = target.length - target_start + start
  }

  var len = end - start

  if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function _augment (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array set method before overwriting
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.indexOf = BP.indexOf
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUIntLE = BP.readUIntLE
  arr.readUIntBE = BP.readUIntBE
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readIntLE = BP.readIntLE
  arr.readIntBE = BP.readIntBE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUIntLE = BP.writeUIntLE
  arr.writeUIntBE = BP.writeUIntBE
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeIntLE = BP.writeIntLE
  arr.writeIntBE = BP.writeIntBE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-z\-]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []
  var i = 0

  for (; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (leadSurrogate) {
        // 2 leads in a row
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          leadSurrogate = codePoint
          continue
        } else {
          // valid surrogate pair
          codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000
          leadSurrogate = null
        }
      } else {
        // no lead yet

        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else {
          // valid lead
          leadSurrogate = codePoint
          continue
        }
      }
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
      leadSurrogate = null
    }

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x200000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

},{"base64-js":13,"ieee754":14,"is-array":15}],13:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],14:[function(require,module,exports){
exports.read = function(buffer, offset, isLE, mLen, nBytes) {
  var e, m,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      nBits = -7,
      i = isLE ? (nBytes - 1) : 0,
      d = isLE ? -1 : 1,
      s = buffer[offset + i];

  i += d;

  e = s & ((1 << (-nBits)) - 1);
  s >>= (-nBits);
  nBits += eLen;
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

  m = e & ((1 << (-nBits)) - 1);
  e >>= (-nBits);
  nBits += mLen;
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
      i = isLE ? 0 : (nBytes - 1),
      d = isLE ? 1 : -1,
      s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }
    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }
    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

  e = (e << mLen) | m;
  eLen += mLen;
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

  buffer[offset + i - d] |= s * 128;
};

},{}],15:[function(require,module,exports){

/**
 * isArray
 */

var isArray = Array.isArray;

/**
 * toString
 */

var str = Object.prototype.toString;

/**
 * Whether or not the given `val`
 * is an array.
 *
 * example:
 *
 *        isArray([]);
 *        // > true
 *        isArray(arguments);
 *        // > false
 *        isArray('');
 *        // > false
 *
 * @param {mixed} val
 * @return {bool}
 */

module.exports = isArray || function (val) {
  return !! val && '[object Array]' == str.call(val);
};

},{}],16:[function(require,module,exports){
/*global define:false require:false */
module.exports = (function(){
	// Import Events
	var events = require('events')

	// Export Domain
	var domain = {}
	domain.createDomain = domain.create = function(){
		var d = new events.EventEmitter()

		function emitError(e) {
			d.emit('error', e)
		}

		d.add = function(emitter){
			emitter.on('error', emitError)
		}
		d.remove = function(emitter){
			emitter.removeListener('error', emitError)
		}
		d.bind = function(fn){
			return function(){
				var args = Array.prototype.slice.call(arguments)
				try {
					fn.apply(null, args)
				}
				catch (err){
					emitError(err)
				}
			}
		}
		d.intercept = function(fn){
			return function(err){
				if ( err ) {
					emitError(err)
				}
				else {
					var args = Array.prototype.slice.call(arguments, 1)
					try {
						fn.apply(null, args)
					}
					catch (err){
						emitError(err)
					}
				}
			}
		}
		d.run = function(fn){
			try {
				fn()
			}
			catch (err) {
				emitError(err)
			}
			return this
		};
		d.dispose = function(){
			this.removeAllListeners()
			return this
		};
		d.enter = d.exit = function(){
			return this
		}
		return d
	};
	return domain
}).call(this)
},{"events":17}],17:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],18:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],19:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;

function drainQueue() {
    if (draining) {
        return;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        var i = -1;
        while (++i < len) {
            currentQueue[i]();
        }
        len = queue.length;
    }
    draining = false;
}
process.nextTick = function (fun) {
    queue.push(fun);
    if (!draining) {
        setTimeout(drainQueue, 0);
    }
};

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],20:[function(require,module,exports){
(function (global){
/*! http://mths.be/punycode v1.2.4 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports;
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^ -~]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /\x2E|\u3002|\uFF0E|\uFF61/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		while (length--) {
			array[length] = fn(array[length]);
		}
		return array;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings.
	 * @private
	 * @param {String} domain The domain name.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		return map(string.split(regexSeparators), fn).join('.');
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <http://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols to a Punycode string of ASCII-only
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name to Unicode. Only the
	 * Punycoded parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it on a string that has already been converted to
	 * Unicode.
	 * @memberOf punycode
	 * @param {String} domain The Punycode domain name to convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(domain) {
		return mapDomain(domain, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name to Punycode. Only the
	 * non-ASCII parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it with a domain that's already in ASCII.
	 * @memberOf punycode
	 * @param {String} domain The domain name to convert, as a Unicode string.
	 * @returns {String} The Punycode representation of the given domain name.
	 */
	function toASCII(domain) {
		return mapDomain(domain, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.2.4',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <http://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],21:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],22:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],23:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":21,"./encode":22}],24:[function(require,module,exports){
module.exports = require("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":25}],25:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

module.exports = Duplex;

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) keys.push(key);
  return keys;
}
/*</replacement>*/


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

forEach(objectKeys(Writable.prototype), function(method) {
  if (!Duplex.prototype[method])
    Duplex.prototype[method] = Writable.prototype[method];
});

function Duplex(options) {
  if (!(this instanceof Duplex))
    return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false)
    this.readable = false;

  if (options && options.writable === false)
    this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false)
    this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended)
    return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  process.nextTick(this.end.bind(this));
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

}).call(this,require('_process'))
},{"./_stream_readable":27,"./_stream_writable":29,"_process":19,"core-util-is":30,"inherits":40}],26:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough))
    return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function(chunk, encoding, cb) {
  cb(null, chunk);
};

},{"./_stream_transform":28,"core-util-is":30,"inherits":40}],27:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Readable;

/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Readable.ReadableState = ReadableState;

var EE = require('events').EventEmitter;

/*<replacement>*/
if (!EE.listenerCount) EE.listenerCount = function(emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

var Stream = require('stream');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var StringDecoder;


/*<replacement>*/
var debug = require('util');
if (debug && debug.debuglog) {
  debug = debug.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/


util.inherits(Readable, Stream);

function ReadableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = options.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.buffer = [];
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;


  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.readableObjectMode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder)
      StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  var Duplex = require('./_stream_duplex');

  if (!(this instanceof Readable))
    return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  var state = this._readableState;

  if (util.isString(chunk) && !state.objectMode) {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = new Buffer(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function(chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (util.isNullOrUndefined(chunk)) {
    state.reading = false;
    if (!state.ended)
      onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var e = new Error('stream.unshift() after end event');
      stream.emit('error', e);
    } else {
      if (state.decoder && !addToFront && !encoding)
        chunk = state.decoder.write(chunk);

      if (!addToFront)
        state.reading = false;

      // if we want the data now, just emit it.
      if (state.flowing && state.length === 0 && !state.sync) {
        stream.emit('data', chunk);
        stream.read(0);
      } else {
        // update the buffer info.
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront)
          state.buffer.unshift(chunk);
        else
          state.buffer.push(chunk);

        if (state.needReadable)
          emitReadable(stream);
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}



// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended &&
         (state.needReadable ||
          state.length < state.highWaterMark ||
          state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function(enc) {
  if (!StringDecoder)
    StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 128MB
var MAX_HWM = 0x800000;
function roundUpToNextPowerOf2(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2
    n--;
    for (var p = 1; p < 32; p <<= 1) n |= n >> p;
    n++;
  }
  return n;
}

function howMuchToRead(n, state) {
  if (state.length === 0 && state.ended)
    return 0;

  if (state.objectMode)
    return n === 0 ? 0 : 1;

  if (isNaN(n) || util.isNull(n)) {
    // only flow one buffer at a time
    if (state.flowing && state.buffer.length)
      return state.buffer[0].length;
    else
      return state.length;
  }

  if (n <= 0)
    return 0;

  // If we're asking for more than the target buffer level,
  // then raise the water mark.  Bump up to the next highest
  // power of 2, to prevent increasing it excessively in tiny
  // amounts.
  if (n > state.highWaterMark)
    state.highWaterMark = roundUpToNextPowerOf2(n);

  // don't have that much.  return null, unless we've ended.
  if (n > state.length) {
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    } else
      return state.length;
  }

  return n;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  debug('read', n);
  var state = this._readableState;
  var nOrig = n;

  if (!util.isNumber(n) || n > 0)
    state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended)
      endReadable(this);
    else
      emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0)
      endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  }

  if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
  }

  // If _read pushed data synchronously, then `reading` will be false,
  // and we need to re-evaluate how much data we can return to the user.
  if (doRead && !state.reading)
    n = howMuchToRead(nOrig, state);

  var ret;
  if (n > 0)
    ret = fromList(n, state);
  else
    ret = null;

  if (util.isNull(ret)) {
    state.needReadable = true;
    n = 0;
  }

  state.length -= n;

  // If we have nothing in the buffer, then we want to know
  // as soon as we *do* get something into the buffer.
  if (state.length === 0 && !state.ended)
    state.needReadable = true;

  // If we tried to read() past the EOF, then emit end on the next tick.
  if (nOrig !== n && state.ended && state.length === 0)
    endReadable(this);

  if (!util.isNull(ret))
    this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!util.isBuffer(chunk) &&
      !util.isString(chunk) &&
      !util.isNullOrUndefined(chunk) &&
      !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}


function onEofChunk(stream, state) {
  if (state.decoder && !state.ended) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync)
      process.nextTick(function() {
        emitReadable_(stream);
      });
    else
      emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}


// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    process.nextTick(function() {
      maybeReadMore_(stream, state);
    });
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended &&
         state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;
    else
      len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function(n) {
  this.emit('error', new Error('not implemented'));
};

Readable.prototype.pipe = function(dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted)
    process.nextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain &&
        (!dest._writableState || dest._writableState.needDrain))
      ondrain();
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    var ret = dest.write(chunk);
    if (false === ret) {
      debug('false write response, pause',
            src._readableState.awaitDrain);
      src._readableState.awaitDrain++;
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EE.listenerCount(dest, 'error') === 0)
      dest.emit('error', er);
  }
  // This is a brutally ugly hack to make sure that our error handler
  // is attached before any userland ones.  NEVER DO THIS.
  if (!dest._events || !dest._events.error)
    dest.on('error', onerror);
  else if (isArray(dest._events.error))
    dest._events.error.unshift(onerror);
  else
    dest._events.error = [onerror, dest._events.error];



  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function() {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain)
      state.awaitDrain--;
    if (state.awaitDrain === 0 && EE.listenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}


Readable.prototype.unpipe = function(dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0)
    return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes)
      return this;

    if (!dest)
      dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest)
      dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++)
      dests[i].emit('unpipe', this);
    return this;
  }

  // try to find the right one.
  var i = indexOf(state.pipes, dest);
  if (i === -1)
    return this;

  state.pipes.splice(i, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1)
    state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function(ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  // If listening to data, and it has not explicitly been paused,
  // then call resume to start the flow of data on the next tick.
  if (ev === 'data' && false !== this._readableState.flowing) {
    this.resume();
  }

  if (ev === 'readable' && this.readable) {
    var state = this._readableState;
    if (!state.readableListening) {
      state.readableListening = true;
      state.emittedReadable = false;
      state.needReadable = true;
      if (!state.reading) {
        var self = this;
        process.nextTick(function() {
          debug('readable nexttick read 0');
          self.read(0);
        });
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    if (!state.reading) {
      debug('resume read 0');
      this.read(0);
    }
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    process.nextTick(function() {
      resume_(stream, state);
    });
  }
}

function resume_(stream, state) {
  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading)
    stream.read(0);
}

Readable.prototype.pause = function() {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  if (state.flowing) {
    do {
      var chunk = stream.read();
    } while (null !== chunk && state.flowing);
  }
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function() {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function(chunk) {
    debug('wrapped data');
    if (state.decoder)
      chunk = state.decoder.write(chunk);
    if (!chunk || !state.objectMode && !chunk.length)
      return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (util.isFunction(stream[i]) && util.isUndefined(this[i])) {
      this[i] = function(method) { return function() {
        return stream[method].apply(stream, arguments);
      }}(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function(ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function(n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};



// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
function fromList(n, state) {
  var list = state.buffer;
  var length = state.length;
  var stringMode = !!state.decoder;
  var objectMode = !!state.objectMode;
  var ret;

  // nothing in the list, definitely empty.
  if (list.length === 0)
    return null;

  if (length === 0)
    ret = null;
  else if (objectMode)
    ret = list.shift();
  else if (!n || n >= length) {
    // read it all, truncate the array.
    if (stringMode)
      ret = list.join('');
    else
      ret = Buffer.concat(list, length);
    list.length = 0;
  } else {
    // read just some of it.
    if (n < list[0].length) {
      // just take a part of the first list item.
      // slice is the same for buffers and strings.
      var buf = list[0];
      ret = buf.slice(0, n);
      list[0] = buf.slice(n);
    } else if (n === list[0].length) {
      // first list is a perfect match
      ret = list.shift();
    } else {
      // complex case.
      // we have enough to cover it, but it spans past the first buffer.
      if (stringMode)
        ret = '';
      else
        ret = new Buffer(n);

      var c = 0;
      for (var i = 0, l = list.length; i < l && c < n; i++) {
        var buf = list[0];
        var cpy = Math.min(n - c, buf.length);

        if (stringMode)
          ret += buf.slice(0, cpy);
        else
          buf.copy(ret, c, 0, cpy);

        if (cpy < buf.length)
          list[0] = buf.slice(cpy);
        else
          list.shift();

        c += cpy;
      }
    }
  }

  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0)
    throw new Error('endReadable called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    process.nextTick(function() {
      // Check that we didn't get one last unshift.
      if (!state.endEmitted && state.length === 0) {
        state.endEmitted = true;
        stream.readable = false;
        stream.emit('end');
      }
    });
  }
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf (xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}

}).call(this,require('_process'))
},{"./_stream_duplex":25,"_process":19,"buffer":12,"core-util-is":30,"events":17,"inherits":40,"isarray":18,"stream":35,"string_decoder/":36,"util":11}],28:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.


// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);


function TransformState(options, stream) {
  this.afterTransform = function(er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb)
    return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (!util.isNullOrUndefined(data))
    stream.push(data);

  if (cb)
    cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}


function Transform(options) {
  if (!(this instanceof Transform))
    return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(options, this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  this.once('prefinish', function() {
    if (util.isFunction(this._flush))
      this._flush(function(er) {
        done(stream, er);
      });
    else
      done(stream);
  });
}

Transform.prototype.push = function(chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function(chunk, encoding, cb) {
  throw new Error('not implemented');
};

Transform.prototype._write = function(chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform ||
        rs.needReadable ||
        rs.length < rs.highWaterMark)
      this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function(n) {
  var ts = this._transformState;

  if (!util.isNull(ts.writechunk) && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};


function done(stream, er) {
  if (er)
    return stream.emit('error', er);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length)
    throw new Error('calling transform done when ws.length != 0');

  if (ts.transforming)
    throw new Error('calling transform done when still transforming');

  return stream.push(null);
}

},{"./_stream_duplex":25,"core-util-is":30,"inherits":40}],29:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, cb), and it'll handle all
// the drain event emission and buffering.

module.exports = Writable;

/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Writable.WritableState = WritableState;


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Stream = require('stream');

util.inherits(Writable, Stream);

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
}

function WritableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = options.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.writableObjectMode;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function(er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.buffer = [];

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;
}

function Writable(options) {
  var Duplex = require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  this.emit('error', new Error('Cannot pipe. Not readable.'));
};


function writeAfterEnd(stream, state, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  process.nextTick(function() {
    cb(er);
  });
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  if (!util.isBuffer(chunk) &&
      !util.isString(chunk) &&
      !util.isNullOrUndefined(chunk) &&
      !state.objectMode) {
    var er = new TypeError('Invalid non-string/buffer chunk');
    stream.emit('error', er);
    process.nextTick(function() {
      cb(er);
    });
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function(chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (util.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }

  if (util.isBuffer(chunk))
    encoding = 'buffer';
  else if (!encoding)
    encoding = state.defaultEncoding;

  if (!util.isFunction(cb))
    cb = function() {};

  if (state.ended)
    writeAfterEnd(this, state, cb);
  else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function() {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function() {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing &&
        !state.corked &&
        !state.finished &&
        !state.bufferProcessing &&
        state.buffer.length)
      clearBuffer(this, state);
  }
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode &&
      state.decodeStrings !== false &&
      util.isString(chunk)) {
    chunk = new Buffer(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);
  if (util.isBuffer(chunk))
    encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret)
    state.needDrain = true;

  if (state.writing || state.corked)
    state.buffer.push(new WriteReq(chunk, encoding, cb));
  else
    doWrite(stream, state, false, len, chunk, encoding, cb);

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev)
    stream._writev(chunk, state.onwrite);
  else
    stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  if (sync)
    process.nextTick(function() {
      state.pendingcb--;
      cb(er);
    });
  else {
    state.pendingcb--;
    cb(er);
  }

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er)
    onwriteError(stream, state, sync, er, cb);
  else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(stream, state);

    if (!finished &&
        !state.corked &&
        !state.bufferProcessing &&
        state.buffer.length) {
      clearBuffer(stream, state);
    }

    if (sync) {
      process.nextTick(function() {
        afterWrite(stream, state, finished, cb);
      });
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished)
    onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}


// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;

  if (stream._writev && state.buffer.length > 1) {
    // Fast case, write everything using _writev()
    var cbs = [];
    for (var c = 0; c < state.buffer.length; c++)
      cbs.push(state.buffer[c].callback);

    // count the one we are adding, as well.
    // TODO(isaacs) clean this up
    state.pendingcb++;
    doWrite(stream, state, true, state.length, state.buffer, '', function(err) {
      for (var i = 0; i < cbs.length; i++) {
        state.pendingcb--;
        cbs[i](err);
      }
    });

    // Clear buffer
    state.buffer = [];
  } else {
    // Slow case, write chunks one-by-one
    for (var c = 0; c < state.buffer.length; c++) {
      var entry = state.buffer[c];
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);

      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        c++;
        break;
      }
    }

    if (c < state.buffer.length)
      state.buffer = state.buffer.slice(c);
    else
      state.buffer.length = 0;
  }

  state.bufferProcessing = false;
}

Writable.prototype._write = function(chunk, encoding, cb) {
  cb(new Error('not implemented'));

};

Writable.prototype._writev = null;

Writable.prototype.end = function(chunk, encoding, cb) {
  var state = this._writableState;

  if (util.isFunction(chunk)) {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (util.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }

  if (!util.isNullOrUndefined(chunk))
    this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished)
    endWritable(this, state, cb);
};


function needFinish(stream, state) {
  return (state.ending &&
          state.length === 0 &&
          !state.finished &&
          !state.writing);
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(stream, state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else
      prefinish(stream, state);
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished)
      process.nextTick(cb);
    else
      stream.once('finish', cb);
  }
  state.ended = true;
}

}).call(this,require('_process'))
},{"./_stream_duplex":25,"_process":19,"buffer":12,"core-util-is":30,"inherits":40,"stream":35}],30:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

function isBuffer(arg) {
  return Buffer.isBuffer(arg);
}
exports.isBuffer = isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}
}).call(this,require("buffer").Buffer)
},{"buffer":12}],31:[function(require,module,exports){
module.exports = require("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":26}],32:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = require('stream');
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":25,"./lib/_stream_passthrough.js":26,"./lib/_stream_readable.js":27,"./lib/_stream_transform.js":28,"./lib/_stream_writable.js":29,"stream":35}],33:[function(require,module,exports){
module.exports = require("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":28}],34:[function(require,module,exports){
module.exports = require("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":29}],35:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":17,"inherits":40,"readable-stream/duplex.js":24,"readable-stream/passthrough.js":31,"readable-stream/readable.js":32,"readable-stream/transform.js":33,"readable-stream/writable.js":34}],36:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = require('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":12}],37:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var punycode = require('punycode');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a puny coded representation of "domain".
      // It only converts the part of the domain name that
      // has non ASCII characters. I.e. it dosent matter if
      // you call it with a domain that already is in ASCII.
      var domainArray = this.hostname.split('.');
      var newOut = [];
      for (var i = 0; i < domainArray.length; ++i) {
        var s = domainArray[i];
        newOut.push(s.match(/[^A-Za-z0-9_-]/) ?
            'xn--' + punycode.encode(s) : s);
      }
      this.hostname = newOut.join('.');
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  Object.keys(this).forEach(function(k) {
    result[k] = this[k];
  }, this);

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    Object.keys(relative).forEach(function(k) {
      if (k !== 'protocol')
        result[k] = relative[k];
    });

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      Object.keys(relative).forEach(function(k) {
        result[k] = relative[k];
      });
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especialy happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!isNull(result.pathname) || !isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host) && (last === '.' || last === '..') ||
      last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last == '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especialy happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!isNull(result.pathname) || !isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

function isString(arg) {
  return typeof arg === "string";
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isNull(arg) {
  return arg === null;
}
function isNullOrUndefined(arg) {
  return  arg == null;
}

},{"punycode":20,"querystring":23}],38:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],39:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":38,"_process":19,"inherits":40}],40:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],41:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./abstracts/MediaElement');


/**
 * Creates a {@link module:core.HubPort HubPort} for the given {@link
 * module:core/abstracts.Hub Hub}
 *
 * @classdesc
 *  This {@link module:core/abstracts.MediaElement MediaElement} specifies a
 *  connection with a {@link module:core/abstracts.Hub Hub}
 *
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core.HubPort
 */
function HubPort(){
  HubPort.super_.call(this);
};
inherits(HubPort, MediaElement);


/**
 * @alias module:core.HubPort.constructorParams
 *
 * @property {module:core/abstracts.Hub} hub
 *  {@link module:core/abstracts.Hub Hub} to which this port belongs
 */
HubPort.constructorParams = {
  hub: {
    type: 'Hub',
    required: true
  },
};

/**
 * @alias module:core.HubPort.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
HubPort.events = MediaElement.events;


/**
 * Checker for {@link core.HubPort}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.HubPort} value
 */
function checkHubPort(key, value)
{
  if(!(value instanceof HubPort))
    throw ChecktypeError(key, HubPort, value);
};


module.exports = HubPort;

HubPort.check = checkHubPort;

},{"./abstracts/MediaElement":48,"inherits":40,"kurento-client":"kurento-client"}],42:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var MediaObjectCreator  = kurentoClient.MediaObjectCreator;
var TransactionsManager = kurentoClient.TransactionsManager;

var transactionOperation = TransactionsManager.transactionOperation;

var MediaObject = require('./abstracts/MediaObject');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create a {@link module:core.MediaPipeline MediaPipeline}
 *
 * @classdesc
 *  A pipeline is a container for a collection of {@link
 *  module:core/abstracts.MediaElement MediaElements} and
 *  :rom:cls:`MediaMixers<MediaMixer>`. It offers the methods needed to control
 *  the creation and connection of elements inside a certain pipeline.
 *
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core.MediaPipeline
 */
function MediaPipeline(){
  MediaPipeline.super_.call(this);


  var self = this;


  // Transactional API

  var transactionsManager = new TransactionsManager(this, encodeTransaction);

  this.beginTransaction = transactionsManager.beginTransaction.bind(transactionsManager);
  this.endTransaction   = transactionsManager.endTransaction.bind(transactionsManager);
  this.transaction      = transactionsManager.transaction.bind(transactionsManager);


  // Encode commands

  function encodeCreate(transaction, params, callback)
  {
    if(transaction)
      return transactionOperation.call(transaction, 'create', params, callback);

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'create', params, callback);

    self.emit('_create', undefined, params, callback)
  }

  function encodeRpc(transaction, method, params, callback)
  {
    if(transaction)
      return transactionOperation.call(transaction, method, params, callback);

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, method, params, callback);

    self.emit('_rpc', undefined, method, params, callback)
  }

  function encodeTransaction(operations, callback)
  {
    var params =
    {
//      object: self,
      operations: operations
    };

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction', params, callback);

    self.emit('_transaction', params, callback);
  }

  var describe = this.emit.bind(this, '_describe');


  // Creation of objects

  var mediaObjectCreator = new MediaObjectCreator(this, encodeCreate, encodeRpc, encodeTransaction, describe);

  /**
   * Create a new instance of a {module:core/abstract.MediaObject} attached to
   *  this {module:core.MediaPipeline}
   *
   * @param {external:String} type - Type of the
   *  {module:core/abstract.MediaObject}
   * @param {external:String[]} [params]
   * @param {module:core.MediaPipeline~createCallback} callback
   *
   * @return {external:Promise}
   */
  this.create = mediaObjectCreator.create.bind(mediaObjectCreator);
  /**
   * @callback core.MediaPipeline~createCallback
   * @param {external:Error} error
   * @param {module:core/abstract~MediaElement} result
   *  The created MediaElement
   */
};
inherits(MediaPipeline, MediaObject);


//
// Public methods
//


/**
 * Returns a string in dot (graphviz) format that represents the gstreamer
 * elements inside the pipeline
 *
 * @alias module:core.MediaPipeline.getGstreamerDot
 *
 * @param {module:core/complexTypes.GstreamerDotDetails} [details]
 *  Details of graph
 *
 * @param {module:core.MediaPipeline~getGstreamerDotCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaPipeline.prototype.getGstreamerDot = function(details, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 0: details = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+0+'-'+1+']');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  checkType('GstreamerDotDetails', 'details', details);

  var params = {
    details: details,
  };

  return this._invoke(transaction, 'getGstreamerDot', params, callback);
};
/**
 * @callback module:core.MediaPipeline~getGstreamerDotCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The dot graph
 */


/**
 * @alias module:core.MediaPipeline.constructorParams
 */
MediaPipeline.constructorParams = {};

/**
 * @alias module:core.MediaPipeline.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
MediaPipeline.events = MediaObject.events;


/**
 * Checker for {@link core.MediaPipeline}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.MediaPipeline} value
 */
function checkMediaPipeline(key, value)
{
  if(!(value instanceof MediaPipeline))
    throw ChecktypeError(key, MediaPipeline, value);
};


module.exports = MediaPipeline;

MediaPipeline.check = checkMediaPipeline;

},{"./abstracts/MediaObject":49,"inherits":40,"kurento-client":"kurento-client"}],43:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./abstracts/MediaElement');


/**
 * Builder for the {@link module:core.PassThrough PassThrough}
 *
 * @classdesc
 *  This {@link module:core/abstracts.MediaElement MediaElement} that just
 *  passes media through
 *
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core.PassThrough
 */
function PassThrough(){
  PassThrough.super_.call(this);
};
inherits(PassThrough, MediaElement);


/**
 * @alias module:core.PassThrough.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the element
 *  belongs
 */
PassThrough.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:core.PassThrough.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
PassThrough.events = MediaElement.events;


/**
 * Checker for {@link core.PassThrough}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.PassThrough} value
 */
function checkPassThrough(key, value)
{
  if(!(value instanceof PassThrough))
    throw ChecktypeError(key, PassThrough, value);
};


module.exports = PassThrough;

PassThrough.check = checkPassThrough;

},{"./abstracts/MediaElement":48,"inherits":40,"kurento-client":"kurento-client"}],44:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var SdpEndpoint = require('./SdpEndpoint');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Base class to manage common RTP features.
 *
 * @abstract
 * @extends module:core/abstracts.SdpEndpoint
 *
 * @constructor module:core/abstracts.BaseRtpEndpoint
 *
 * @fires {@link module:core#event:MediaStateChanged MediaStateChanged}
 */
function BaseRtpEndpoint(){
  BaseRtpEndpoint.super_.call(this);
};
inherits(BaseRtpEndpoint, SdpEndpoint);


//
// Public properties
//

/**
 * Maximum video bandwidth for sending.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 500
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMaxVideoSendBandwidth
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMaxVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMaxVideoSendBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMaxVideoSendBandwidth', callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMaxVideoSendBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Maximum video bandwidth for sending.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 500
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setMaxVideoSendBandwidth
 *
 * @param {external:Integer} maxVideoSendBandwidth
 * @param {module:core/abstracts.BaseRtpEndpoint~setMaxVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setMaxVideoSendBandwidth = function(maxVideoSendBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'maxVideoSendBandwidth', maxVideoSendBandwidth, {required: true});

  var params = {
    maxVideoSendBandwidth: maxVideoSendBandwidth,
  };

  return this._invoke(transaction, 'setMaxVideoSendBandwidth', params, callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setMaxVideoSendBandwidthCallback
 * @param {external:Error} error
 */

/**
 * State of the media
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMediaState
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMediaStateCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMediaState = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMediaState', callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMediaStateCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.MediaState} result
 */

/**
 * Minimum video bandwidth for sending.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 100
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMinVideoSendBandwidth
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMinVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMinVideoSendBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMinVideoSendBandwidth', callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMinVideoSendBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Minimum video bandwidth for sending.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 100
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setMinVideoSendBandwidth
 *
 * @param {external:Integer} minVideoSendBandwidth
 * @param {module:core/abstracts.BaseRtpEndpoint~setMinVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setMinVideoSendBandwidth = function(minVideoSendBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'minVideoSendBandwidth', minVideoSendBandwidth, {required: true});

  var params = {
    minVideoSendBandwidth: minVideoSendBandwidth,
  };

  return this._invoke(transaction, 'setMinVideoSendBandwidth', params, callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setMinVideoSendBandwidthCallback
 * @param {external:Error} error
 */


//
// Public methods
//


/**
 * Provides statistics collected for this endpoint
 *
 * @alias module:core/abstracts.BaseRtpEndpoint.getStats
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getStatsCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getStats = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'getStats', callback);
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getStatsCallback
 * @param {external:Error} error
 * @param {Object.<string, module:core/complexTypes.RTCStats>} result
 *  Delivers a successful result in the form of a RTC stats report. A RTC stats
 *  report represents a map between strings, identifying the inspected objects
 *  (RTCStats.id), and their corresponding RTCStats objects.
 */


/**
 * @alias module:core/abstracts.BaseRtpEndpoint.constructorParams
 */
BaseRtpEndpoint.constructorParams = {};

/**
 * @alias module:core/abstracts.BaseRtpEndpoint.events
 *
 * @extends module:core/abstracts.SdpEndpoint.events
 */
BaseRtpEndpoint.events = SdpEndpoint.events.concat(['MediaStateChanged']);


/**
 * Checker for {@link core/abstracts.BaseRtpEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.BaseRtpEndpoint} value
 */
function checkBaseRtpEndpoint(key, value)
{
  if(!(value instanceof BaseRtpEndpoint))
    throw ChecktypeError(key, BaseRtpEndpoint, value);
};


module.exports = BaseRtpEndpoint;

BaseRtpEndpoint.check = checkBaseRtpEndpoint;

},{"./SdpEndpoint":50,"inherits":40,"kurento-client":"kurento-client"}],45:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./MediaElement');


/**
 * @classdesc
 *  Base interface for all end points. An Endpoint is a {@link
 *  module:core/abstracts.MediaElement MediaElement}
 *  that allow <a
 *  href="http://www.kurento.org/docs/current/glossary.html#term-kms">KMS</a> to
 *  <a href="http<a href="http://<a
 *  href="http://www.kurento.org/docs/current/glossary.html#term-http">HTTP</a>org/docs/current/glossary.html#term-webrtc">WebRTC</a>.org/docs/current/glossary.html#term-rtp">RTP</a>different
 *  :term:`WebRTC`, :term:`HTTP`, <code>file:/</code> URLs... An
 *  <code>Endpoint</code> may
 *  contain both sources and sinks for different media types, to provide
 *  bidirectional communication.
 *
 * @abstract
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core/abstracts.Endpoint
 */
function Endpoint(){
  Endpoint.super_.call(this);
};
inherits(Endpoint, MediaElement);


/**
 * @alias module:core/abstracts.Endpoint.constructorParams
 */
Endpoint.constructorParams = {};

/**
 * @alias module:core/abstracts.Endpoint.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
Endpoint.events = MediaElement.events;


/**
 * Checker for {@link core/abstracts.Endpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Endpoint} value
 */
function checkEndpoint(key, value)
{
  if(!(value instanceof Endpoint))
    throw ChecktypeError(key, Endpoint, value);
};


module.exports = Endpoint;

Endpoint.check = checkEndpoint;

},{"./MediaElement":48,"inherits":40,"kurento-client":"kurento-client"}],46:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./MediaElement');


/**
 * @classdesc
 *  Base interface for all filters. This is a certain type of {@link
 *  module:core/abstracts.MediaElement MediaElement}, that processes media
 *  injected through its sinks, and delivers the outcome through its sources.
 *
 * @abstract
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core/abstracts.Filter
 */
function Filter(){
  Filter.super_.call(this);
};
inherits(Filter, MediaElement);


/**
 * @alias module:core/abstracts.Filter.constructorParams
 */
Filter.constructorParams = {};

/**
 * @alias module:core/abstracts.Filter.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
Filter.events = MediaElement.events;


/**
 * Checker for {@link core/abstracts.Filter}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Filter} value
 */
function checkFilter(key, value)
{
  if(!(value instanceof Filter))
    throw ChecktypeError(key, Filter, value);
};


module.exports = Filter;

Filter.check = checkFilter;

},{"./MediaElement":48,"inherits":40,"kurento-client":"kurento-client"}],47:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var HubPort = require('../HubPort');

var MediaObject = require('./MediaObject');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  A Hub is a routing {@link module:core/abstracts.MediaObject MediaObject}. It
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.Hub
 */
function Hub(){
  Hub.super_.call(this);
};
inherits(Hub, MediaObject);


/**
 * Create a new instance of a {module:core~HubPort} attached to this {module:core~Hub}
 *
 * @param {module:core/abstract.Hub~createHubCallback} callback
 *
 * @return {external:Promise}
 */
Hub.prototype.createHubPort = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  var mediaObject = new HubPort()

  mediaObject.on('_rpc', this.emit.bind(this, '_rpc'));

  var params =
  {
    type: 'HubPort',
    constructorParams: {hub: this}
  };

  Object.defineProperty(params, 'object', {value: mediaObject});

  this.emit('_create', transaction, params, callback);

  return mediaObject
};
/**
 * @callback core/abstract.Hub~createHubCallback
 * @param {external:Error} error
 * @param {module:core/abstract.HubPort} result
 *  The created HubPort
 */


/**
 * @alias module:core/abstracts.Hub.constructorParams
 */
Hub.constructorParams = {};

/**
 * @alias module:core/abstracts.Hub.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
Hub.events = MediaObject.events;


/**
 * Checker for {@link core/abstracts.Hub}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Hub} value
 */
function checkHub(key, value)
{
  if(!(value instanceof Hub))
    throw ChecktypeError(key, Hub, value);
};


module.exports = Hub;

Hub.check = checkHub;

},{"../HubPort":41,"./MediaObject":49,"inherits":40,"kurento-client":"kurento-client"}],48:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var MediaObject = require('./MediaObject');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Basic building blocks of the media server, that can be interconnected
 *  through the API. A {@link module:core/abstracts.MediaElement MediaElement}
 *  is a module that encapsulates a specific media capability. They can be
 *  connected to create media pipelines where those capabilities are applied, in
 *     {@link module:core/abstracts.MediaElement MediaElement} objects are
 *     classified by its supported media type (audio, video, etc.)
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.MediaElement
 */
function MediaElement(){
  MediaElement.super_.call(this);
};
inherits(MediaElement, MediaObject);


//
// Public methods
//


/**
 * Connects two elements, with the given restrictions, current {@link
 * module:core/abstracts.MediaElement MediaElement} will start emmit media to
 * sink element. Connection could take place in the future, when both media
 * element show capabilities for connecting with the given restrictions
 *
 * @alias module:core/abstracts.MediaElement.connect
 *
 * @param {module:core/abstracts.MediaElement} sink
 *  the target {@link module:core/abstracts.MediaElement MediaElement} that will
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  the {@link MediaType} of the pads that will be connected
 *
 * @param {external:String} [sourceMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {external:String} [sinkMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.connect = function(sink, mediaType, sourceMediaDescription, sinkMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 1: mediaType = undefined;
    case 2: sourceMediaDescription = undefined;
    case 3: sinkMediaDescription = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+1+'-'+4+']');
          error.length = arguments.length;
          error.min = 1;
          error.max = 4;

      throw error;
  }

  checkType('MediaElement', 'sink', sink, {required: true});
  checkType('MediaType', 'mediaType', mediaType);
  checkType('String', 'sourceMediaDescription', sourceMediaDescription);
  checkType('String', 'sinkMediaDescription', sinkMediaDescription);

  var params = {
    sink: sink,
    mediaType: mediaType,
    sourceMediaDescription: sourceMediaDescription,
    sinkMediaDescription: sinkMediaDescription,
  };

  var promise = this._invoke(transaction, 'connect', params, callback);

  promise.connect = sink.connect.bind(sink);

  return promise;
};
/**
 * @callback module:core/abstracts.MediaElement~connectCallback
 * @param {external:Error} error
 */

/**
 * Disconnects two elements, with the given restrictions, current {@link
 * module:core/abstracts.MediaElement MediaElement} stops sending media to sink
 * element. If the previously requested connection didn't took place it is also
 * removed
 *
 * @alias module:core/abstracts.MediaElement.disconnect
 *
 * @param {module:core/abstracts.MediaElement} sink
 *  the target {@link module:core/abstracts.MediaElement MediaElement} that will
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  the {@link MediaType} of the pads that will be connected
 *
 * @param {external:String} [sourceMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {external:String} [sinkMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~disconnectCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.disconnect = function(sink, mediaType, sourceMediaDescription, sinkMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 1: mediaType = undefined;
    case 2: sourceMediaDescription = undefined;
    case 3: sinkMediaDescription = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+1+'-'+4+']');
          error.length = arguments.length;
          error.min = 1;
          error.max = 4;

      throw error;
  }

  checkType('MediaElement', 'sink', sink, {required: true});
  checkType('MediaType', 'mediaType', mediaType);
  checkType('String', 'sourceMediaDescription', sourceMediaDescription);
  checkType('String', 'sinkMediaDescription', sinkMediaDescription);

  var params = {
    sink: sink,
    mediaType: mediaType,
    sourceMediaDescription: sourceMediaDescription,
    sinkMediaDescription: sinkMediaDescription,
  };

  return this._invoke(transaction, 'disconnect', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~disconnectCallback
 * @param {external:Error} error
 */

/**
 * Returns a string in dot (graphviz) format that represents the gstreamer
 * elements inside
 *
 * @alias module:core/abstracts.MediaElement.getGstreamerDot
 *
 * @param {module:core/complexTypes.GstreamerDotDetails} [details]
 *  Details of graph
 *
 * @param {module:core/abstracts.MediaElement~getGstreamerDotCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getGstreamerDot = function(details, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 0: details = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+0+'-'+1+']');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  checkType('GstreamerDotDetails', 'details', details);

  var params = {
    details: details,
  };

  return this._invoke(transaction, 'getGstreamerDot', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~getGstreamerDotCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The dot graph
 */

/**
 * Returns a list of the connections information of the elements that ere
 * receiving media from this element.
 *
 * @alias module:core/abstracts.MediaElement.getSinkConnections
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO}, {@link
 *  module:core/abstracts.MediaElement#MediaType.VIDEO} or {@link
 *  module:core/abstracts.MediaElement#MediaType.DATA}
 *
 * @param {external:String} [description]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~getSinkConnectionsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getSinkConnections = function(mediaType, description, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 0: mediaType = undefined;
    case 1: description = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+0+'-'+2+']');
          error.length = arguments.length;
          error.min = 0;
          error.max = 2;

      throw error;
  }

  checkType('MediaType', 'mediaType', mediaType);
  checkType('String', 'description', description);

  var params = {
    mediaType: mediaType,
    description: description,
  };

  return this._invoke(transaction, 'getSinkConnections', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~getSinkConnectionsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ElementConnectionData} result
 *  A list of the connections information that arereceiving media from this
 *  element. The list will be empty if no sinks are found.
 */

/**
 * Get the connections information of the elements that are sending media to
 * this element {@link module:core/abstracts.MediaElement MediaElement}
 *
 * @alias module:core/abstracts.MediaElement.getSourceConnections
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO}, {@link
 *  module:core/abstracts.MediaElement#MediaType.VIDEO} or {@link
 *  module:core/abstracts.MediaElement#MediaType.DATA}
 *
 * @param {external:String} [description]
 *  A textual description of the media source. Currently not used, aimed mainly
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~getSourceConnectionsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getSourceConnections = function(mediaType, description, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  callback = (callback || noop).bind(this)

  switch(arguments.length){
    case 0: mediaType = undefined;
    case 1: description = undefined;
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range ['+0+'-'+2+']');
          error.length = arguments.length;
          error.min = 0;
          error.max = 2;

      throw error;
  }

  checkType('MediaType', 'mediaType', mediaType);
  checkType('String', 'description', description);

  var params = {
    mediaType: mediaType,
    description: description,
  };

  return this._invoke(transaction, 'getSourceConnections', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~getSourceConnectionsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ElementConnectionData} result
 *  A list of the connections information that are sending media to this
 *  element. The list will be empty if no sources are found.
 */

/**
 * Sets the type of data for the audio stream. MediaElements that do not support
 *
 * @alias module:core/abstracts.MediaElement.setAudioFormat
 *
 * @param {module:core/complexTypes.AudioCaps} caps
 *  The format for the stream of audio
 *
 * @param {module:core/abstracts.MediaElement~setAudioFormatCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setAudioFormat = function(caps, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('AudioCaps', 'caps', caps, {required: true});

  var params = {
    caps: caps,
  };

  return this._invoke(transaction, 'setAudioFormat', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~setAudioFormatCallback
 * @param {external:Error} error
 */

/**
 * Sets the type of data for the video stream. MediaElements that do not support
 *
 * @alias module:core/abstracts.MediaElement.setVideoFormat
 *
 * @param {module:core/complexTypes.VideoCaps} caps
 *  The format for the stream of video
 *
 * @param {module:core/abstracts.MediaElement~setVideoFormatCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setVideoFormat = function(caps, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('VideoCaps', 'caps', caps, {required: true});

  var params = {
    caps: caps,
  };

  return this._invoke(transaction, 'setVideoFormat', params, callback);
};
/**
 * @callback module:core/abstracts.MediaElement~setVideoFormatCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core/abstracts.MediaElement.constructorParams
 */
MediaElement.constructorParams = {};

/**
 * @alias module:core/abstracts.MediaElement.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
MediaElement.events = MediaObject.events;


/**
 * Checker for {@link core/abstracts.MediaElement}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.MediaElement} value
 */
function checkMediaElement(key, value)
{
  if(!(value instanceof MediaElement))
    throw ChecktypeError(key, MediaElement, value);
};


module.exports = MediaElement;

MediaElement.check = checkMediaElement;

},{"./MediaObject":49,"inherits":40,"kurento-client":"kurento-client"}],49:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Promise = require('es6-promise').Promise;

var promiseCallback = require('promisecallback');

var EventEmitter = require('events').EventEmitter;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Base for all objects that can be created in the media server.
 *
 * @abstract
 * @extends external:EventEmitter
 *
 * @constructor module:core/abstracts.MediaObject
 *
 * @fires {@link module:core#event:Error Error}
 */
function MediaObject(){
  MediaObject.super_.call(this);


  var self = this;


  //
  // Define object properties
  //

  /**
   * Unique identifier of this object
   *
   * @public
   * @readonly
   * @member {external:Number} id
   */
  this.once('_id', function(error, id)
  {
    if(error)
    {
      this._createError = error;

      return Object.defineProperty(this, 'id', {value: null});
    }

    Object.defineProperty(this, 'id',
    {
      configurable: true,
      enumerable: true,
      value: id
    });
  })

  //
  // Subscribe and unsubscribe events on the server when adding and removing
  // event listeners on this MediaObject
  //

  var subscriptions = {};

  this.on('removeListener', function(event, listener)
  {
    // Blacklisted events
    if(event[0] == '_'
    || event == 'release'
    || event == 'newListener')
      return;

    var count = EventEmitter.listenerCount(this, event);
    if(count) return;

    var token = subscriptions[event];

    var params =
    {
      object: this,
      subscription: token
    };

    this.emit('_rpc', undefined, 'unsubscribe', params, function(error)
    {
      if(error) return self.emit('error', error);

      delete subscriptions[event];
    });
  });

  this.on('newListener', function(event, listener)
  {
    // Blacklisted events
    if(event[0] == '_'
    || event == 'release')
      return;

    var constructor = this.constructor;

    if(constructor.events.indexOf(event) < 0)
      throw new SyntaxError(constructor.name+" doesn't accept events of type '"+event+"'")

    var count = EventEmitter.listenerCount(this, event);
    if(count) return;

    var params =
    {
      object: this,
      type: event
    };

    this.emit('_rpc', undefined, 'subscribe', params, function(error, token)
    {
      if(error) return self.emit('error', error);

      subscriptions[event] = token;
    });
  });
};
inherits(MediaObject, EventEmitter);


//
// Public properties
//

/**
 * Childs of current object, all returned objects have parent set to current
 * object
 *
 * @alias module:core/abstracts.MediaObject#getChilds
 *
 * @param {module:core/abstracts.MediaObject~getChildsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getChilds = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getChilds', function(error, result)
  {
    if (error) return callback(error);

    this.emit('_describe', result, callback);
  });
};
/**
 * @callback module:core/abstracts.MediaObject~getChildsCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.MediaObject} result
 */

/**
 * {@link module:core.MediaPipeline MediaPipeline} to which this MediaObject
 * belong, or the pipeline itself if invoked over a {@link
 * module:core.MediaPipeline MediaPipeline}
 *
 * @alias module:core/abstracts.MediaObject#getMediaPipeline
 *
 * @param {module:core/abstracts.MediaObject~getMediaPipelineCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getMediaPipeline = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMediaPipeline', function(error, result)
  {
    if (error) return callback(error);

    this.emit('_describe', result, callback);
  });
};
/**
 * @callback module:core/abstracts.MediaObject~getMediaPipelineCallback
 * @param {external:Error} error
 * @param {module:core.MediaPipeline} result
 */

/**
 * Object name. This is just a comodity to simplify developers life debugging,
 * it is not used internally for indexing nor idenfiying the objects. By default
 *
 * @alias module:core/abstracts.MediaObject#getName
 *
 * @param {module:core/abstracts.MediaObject~getNameCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getName = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getName', callback);
};
/**
 * @callback module:core/abstracts.MediaObject~getNameCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * Object name. This is just a comodity to simplify developers life debugging,
 * it is not used internally for indexing nor idenfiying the objects. By default
 *
 * @alias module:core/abstracts.MediaObject#setName
 *
 * @param {external:String} name
 * @param {module:core/abstracts.MediaObject~setNameCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.setName = function(name, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'name', name, {required: true});

  var params = {
    name: name,
  };

  return this._invoke(transaction, 'setName', params, callback);
};
/**
 * @callback module:core/abstracts.MediaObject~setNameCallback
 * @param {external:Error} error
 */

/**
 * parent of this media object. The type of the parent depends on the type of
 * the element. The parent of a :rom:cls:`MediaPad` is its {@link
 * module:core/abstracts.MediaElement MediaElement}; the parent of a {@link
 * module:core/abstracts.Hub Hub} or a {@link module:core/abstracts.MediaElement
 *
 * @alias module:core/abstracts.MediaObject#getParent
 *
 * @param {module:core/abstracts.MediaObject~getParentCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getParent = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getParent', function(error, result)
  {
    if (error) return callback(error);

    this.emit('_describe', result, callback);
  });
};
/**
 * @callback module:core/abstracts.MediaObject~getParentCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.MediaObject} result
 */

/**
 * This property allows activate/deactivate sending the element tags in all its
 * events.
 *
 * @alias module:core/abstracts.MediaObject#getSendTagsInEvents
 *
 * @param {module:core/abstracts.MediaObject~getSendTagsInEventsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getSendTagsInEvents = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getSendTagsInEvents', callback);
};
/**
 * @callback module:core/abstracts.MediaObject~getSendTagsInEventsCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 */

/**
 * This property allows activate/deactivate sending the element tags in all its
 * events.
 *
 * @alias module:core/abstracts.MediaObject#setSendTagsInEvents
 *
 * @param {external:Boolean} sendTagsInEvents
 * @param {module:core/abstracts.MediaObject~setSendTagsInEventsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.setSendTagsInEvents = function(sendTagsInEvents, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('boolean', 'sendTagsInEvents', sendTagsInEvents, {required: true});

  var params = {
    sendTagsInEvents: sendTagsInEvents,
  };

  return this._invoke(transaction, 'setSendTagsInEvents', params, callback);
};
/**
 * @callback module:core/abstracts.MediaObject~setSendTagsInEventsCallback
 * @param {external:Error} error
 */


//
// Public methods
//


/**
 * Request a SessionSpec offer.
 *    This can be used to initiate a connection.
 *
 * @alias module:core/abstracts.MediaObject.addTag
 *
 * @param {external:String} key
 *  Key of the tag
 *
 * @param {external:String} value
 *  Value of the tag
 *
 * @param {module:core/abstracts.MediaObject~addTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.addTag = function(key, value, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'key', key, {required: true});
  checkType('String', 'value', value, {required: true});

  var params = {
    key: key,
    value: value,
  };

  return this._invoke(transaction, 'addTag', params, callback);
};
/**
 * @callback module:core/abstracts.MediaObject~addTagCallback
 * @param {external:Error} error
 */

/**
 * Returns the value associated to the given key.
 *
 * @alias module:core/abstracts.MediaObject.getTag
 *
 * @param {external:String} key
 *  Tag key.
 *
 * @param {module:core/abstracts.MediaObject~getTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getTag = function(key, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'key', key, {required: true});

  var params = {
    key: key,
  };

  return this._invoke(transaction, 'getTag', params, callback);
};
/**
 * @callback module:core/abstracts.MediaObject~getTagCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The value associated to the given key.
 */

/**
 * Returns all the MediaObject tags.
 *
 * @alias module:core/abstracts.MediaObject.getTags
 *
 * @param {module:core/abstracts.MediaObject~getTagsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getTags = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'getTags', callback);
};
/**
 * @callback module:core/abstracts.MediaObject~getTagsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.Tag} result
 *  An array containing all pairs key-value associated to the MediaObject.
 */

/**
 * Remove the tag (key and value) associated to a tag
 *
 * @alias module:core/abstracts.MediaObject.removeTag
 *
 * @param {external:String} key
 *  Key of the tag to remove
 *
 * @param {module:core/abstracts.MediaObject~removeTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.removeTag = function(key, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'key', key, {required: true});

  var params = {
    key: key,
  };

  return this._invoke(transaction, 'removeTag', params, callback);
};
/**
 * @callback module:core/abstracts.MediaObject~removeTagCallback
 * @param {external:Error} error
 */


function throwRpcNotReady()
{
  throw new Error('RPC result is not ready, use .then() method instead');
};

/**
 * Send a command to a media object
 *
 * @param {external:String} method - Command to be executed by the server
 * @param {module:core/abstract.MediaObject.constructorParams} [params]
 * @param {module:core/abstract.MediaObject~invokeCallback} callback
 *
 * @return {external:Promise}
 */
MediaObject.prototype._invoke = function(transaction, method, params, callback){
  var self = this;

  // Fix optional parameters
  if(params instanceof Function)
  {
    if(callback)
      throw new SyntaxError("Nothing can be defined after the callback");

    callback = params;
    params = undefined;
  };

  var promise;
  var error = this._createError;
  if(error)
  {
    promise = Promise.reject(error)

    Object.defineProperty(promise, 'value', {get: function(){throw error}});
  }
  else
  {
    promise = new Promise(function(resolve, reject)
    {
      // Generate request parameters
      var params2 =
      {
        object: self,
        operation: method
      };

      if(params)
        params2.operationParams = params;

      function callback(error, result)
      {
        delete promise.value;

        if(error)
        {
          Object.defineProperty(promise, 'value', {get: function(){throw error}});

          return reject(error);
        }

        var value = result.value;
        if(value === undefined)
          value = self
        else
          Object.defineProperty(promise, 'value', {value: value});

        resolve(value);
      }

      // Do request
      self.emit('_rpc', transaction, 'invoke', params2, callback);
    });

    Object.defineProperty(promise, 'value',
    {
      configurable: true,
      get: throwRpcNotReady
    });
  }

  var then = promise.then
  promise.then = function(onFulfilled, onRejected)
  {
    if(onFulfilled instanceof Function) onFulfilled = onFulfilled.bind(self)
    if(onRejected  instanceof Function) onRejected  = onRejected.bind(self)

    then.call(this, onFulfilled, onRejected)

    return this
  }

  promise = promiseCallback(promise, callback, this);

  return promise
};
/**
 * @callback core/abstract.MediaObject~invokeCallback
 * @param {external:Error} error
 */

/**
 * Explicity release a {@link module:core/abstract.MediaObject MediaObject} from memory
 *
 * All its descendants will be also released and collected
 *
 * @param {module:core/abstract.MediaObject~releaseCallback} callback
 *
 * @return {external:Promise}
 */
MediaObject.prototype.release = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  var self = this;

  var promise;
  var error = this._createError;
  if(error)
    promise = Promise.reject(error)
  else
    promise = new Promise(function(resolve, reject)
    {
      var params =
      {
        object: self
      };

      function callback(error)
      {
        if(error) return reject(error);

        // Object was sucessfully released on the server,
        // remove it from cache and all its events
        self.emit('release');
        Object.keys(self._events).forEach(function(event)
        {
          if(event[0] == '_'
          || event == 'newListener'
          || event == 'removeListener')
            return;

          self.removeAllListeners(event);
        })

        // Set id as null since the object don't exists anymore on the server so
        // subsequent operations fail inmediatly
        Object.defineProperty(self, 'id', {value: null});

        resolve();
      }

      self.emit('_rpc', transaction, 'release', params, callback);
    });

  return promiseCallback(promise, callback);
};
/**
 * @callback core/abstract.MediaObject~releaseCallback
 * @param {external:Error} error
 */


// Promise interface ("thenable")

MediaObject.prototype.then = function(onFulfilled, onRejected){
  var self = this;

  return new Promise(function(resolve, reject)
  {
    function success(id)
    {
      var result;

      if(onFulfilled)
        try
        {
          result = onFulfilled.call(self, id);
        }
        catch(exception)
        {
          if(!onRejected)
            console.trace('Uncaugh exception', exception)

          return reject(exception);
        }

      resolve(result);
    };
    function failure(error)
    {
      if(onRejected)
        try
        {
          error = onRejected.call(self, error);
        }
        catch(exception)
        {
          return reject(exception);
        }
      else
        console.trace('Uncaugh exception', error)

      reject(error);
    };

    if(self.id === null)
    {
      var error = new Error('MediaObject not found in server');
          error.code = 40101;
          error.object = self;

      failure(error)
    }
    else if(self.id !== undefined)
      success(self)
    else
      self.once('_id', function(error, id)
      {
        if(error) return failure(error);

        success(self);
      })
  })
}

Object.defineProperty(MediaObject.prototype, 'commited',
{
  get: function(){return this.id !== undefined;}
});


/**
 * @alias module:core/abstracts.MediaObject.constructorParams
 */
MediaObject.constructorParams = {};

/**
 * @alias module:core/abstracts.MediaObject.events
 */
MediaObject.events = ['Error'];


/**
 * Checker for {@link core/abstracts.MediaObject}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.MediaObject} value
 */
function checkMediaObject(key, value)
{
  if(!(value instanceof MediaObject))
    throw ChecktypeError(key, MediaObject, value);
};


module.exports = MediaObject;

MediaObject.check = checkMediaObject;

},{"es6-promise":9,"events":17,"inherits":40,"kurento-client":"kurento-client","promisecallback":122}],50:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var SessionEndpoint = require('./SessionEndpoint');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Implements an SDP negotiation endpoint able to generate and process
 *  offers/responses and that configures resources according to negotiated
 *  Session Description
 *
 * @abstract
 * @extends module:core/abstracts.SessionEndpoint
 *
 * @constructor module:core/abstracts.SdpEndpoint
 */
function SdpEndpoint(){
  SdpEndpoint.super_.call(this);
};
inherits(SdpEndpoint, SessionEndpoint);


//
// Public properties
//

/**
 * Maximum video bandwidth for receiving.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 500
 *
 * @alias module:core/abstracts.SdpEndpoint#getMaxVideoRecvBandwidth
 *
 * @param {module:core/abstracts.SdpEndpoint~getMaxVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getMaxVideoRecvBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMaxVideoRecvBandwidth', callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getMaxVideoRecvBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Maximum video bandwidth for receiving.
 *   Unit: kbps(kilobits per second).
 *    0: unlimited.
 *   Default value: 500
 *
 * @alias module:core/abstracts.SdpEndpoint#setMaxVideoRecvBandwidth
 *
 * @param {external:Integer} maxVideoRecvBandwidth
 * @param {module:core/abstracts.SdpEndpoint~setMaxVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.setMaxVideoRecvBandwidth = function(maxVideoRecvBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'maxVideoRecvBandwidth', maxVideoRecvBandwidth, {required: true});

  var params = {
    maxVideoRecvBandwidth: maxVideoRecvBandwidth,
  };

  return this._invoke(transaction, 'setMaxVideoRecvBandwidth', params, callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~setMaxVideoRecvBandwidthCallback
 * @param {external:Error} error
 */


//
// Public methods
//


/**
 * Request a SessionSpec offer.
 *    This can be used to initiate a connection.
 *
 * @alias module:core/abstracts.SdpEndpoint.generateOffer
 *
 * @param {module:core/abstracts.SdpEndpoint~generateOfferCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.generateOffer = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'generateOffer', callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~generateOfferCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The SDP offer.
 */

/**
 * This method gives access to the SessionSpec offered by this
 * NetworkConnection.
 * <hr/><b>Note</b> This method returns the local MediaSpec, negotiated or not.
 * If no offer has been generated yet, it returns null. It an offer has been
 * generated it returns the offer and if an answer has been processed it returns
 *
 * @alias module:core/abstracts.SdpEndpoint.getLocalSessionDescriptor
 *
 * @param {module:core/abstracts.SdpEndpoint~getLocalSessionDescriptorCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getLocalSessionDescriptor = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'getLocalSessionDescriptor', callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getLocalSessionDescriptorCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The last agreed SessionSpec
 */

/**
 * This method gives access to the remote session description.
 * <hr/><b>Note</b> This method returns the media previously agreed after a
 * complete offer-answer exchange. If no media has been agreed yet, it returns
 * null.
 *
 * @alias module:core/abstracts.SdpEndpoint.getRemoteSessionDescriptor
 *
 * @param {module:core/abstracts.SdpEndpoint~getRemoteSessionDescriptorCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getRemoteSessionDescriptor = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'getRemoteSessionDescriptor', callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getRemoteSessionDescriptorCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The last agreed User Agent session description
 */

/**
 * Request the NetworkConnection to process the given SessionSpec answer (from
 * the remote User Agent).
 *
 * @alias module:core/abstracts.SdpEndpoint.processAnswer
 *
 * @param {external:String} answer
 *  SessionSpec answer from the remote User Agent
 *
 * @param {module:core/abstracts.SdpEndpoint~processAnswerCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.processAnswer = function(answer, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'answer', answer, {required: true});

  var params = {
    answer: answer,
  };

  return this._invoke(transaction, 'processAnswer', params, callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~processAnswerCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  Updated SDP offer, based on the answer received.
 */

/**
 * Request the NetworkConnection to process the given SessionSpec offer (from
 * the remote User Agent)
 *
 * @alias module:core/abstracts.SdpEndpoint.processOffer
 *
 * @param {external:String} offer
 *  SessionSpec offer from the remote User Agent
 *
 * @param {module:core/abstracts.SdpEndpoint~processOfferCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.processOffer = function(offer, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'offer', offer, {required: true});

  var params = {
    offer: offer,
  };

  return this._invoke(transaction, 'processOffer', params, callback);
};
/**
 * @callback module:core/abstracts.SdpEndpoint~processOfferCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The chosen configuration from the ones stated in the SDP offer
 */


/**
 * @alias module:core/abstracts.SdpEndpoint.constructorParams
 */
SdpEndpoint.constructorParams = {};

/**
 * @alias module:core/abstracts.SdpEndpoint.events
 *
 * @extends module:core/abstracts.SessionEndpoint.events
 */
SdpEndpoint.events = SessionEndpoint.events;


/**
 * Checker for {@link core/abstracts.SdpEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.SdpEndpoint} value
 */
function checkSdpEndpoint(key, value)
{
  if(!(value instanceof SdpEndpoint))
    throw ChecktypeError(key, SdpEndpoint, value);
};


module.exports = SdpEndpoint;

SdpEndpoint.check = checkSdpEndpoint;

},{"./SessionEndpoint":52,"inherits":40,"kurento-client":"kurento-client"}],51:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var MediaObject = require('./MediaObject');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  This is a standalone object for managing the MediaServer
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.ServerManager
 *
 * @fires {@link module:core#event:ObjectCreated ObjectCreated}
 * @fires {@link module:core#event:ObjectDestroyed ObjectDestroyed}
 */
function ServerManager(){
  ServerManager.super_.call(this);
};
inherits(ServerManager, MediaObject);


//
// Public properties
//

/**
 * Server information, version, modules, factories, etc
 *
 * @alias module:core/abstracts.ServerManager#getInfo
 *
 * @param {module:core/abstracts.ServerManager~getInfoCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getInfo = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getInfo', callback);
};
/**
 * @callback module:core/abstracts.ServerManager~getInfoCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ServerInfo} result
 */

/**
 * Metadata stored in the server
 *
 * @alias module:core/abstracts.ServerManager#getMetadata
 *
 * @param {module:core/abstracts.ServerManager~getMetadataCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getMetadata = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getMetadata', callback);
};
/**
 * @callback module:core/abstracts.ServerManager~getMetadataCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * All the pipelines available in the server
 *
 * @alias module:core/abstracts.ServerManager#getPipelines
 *
 * @param {module:core/abstracts.ServerManager~getPipelinesCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getPipelines = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getPipelines', function(error, result)
  {
    if (error) return callback(error);

    this.emit('_describe', result, callback);
  });
};
/**
 * @callback module:core/abstracts.ServerManager~getPipelinesCallback
 * @param {external:Error} error
 * @param {module:core.MediaPipeline} result
 */

/**
 * All active sessions in the server
 *
 * @alias module:core/abstracts.ServerManager#getSessions
 *
 * @param {module:core/abstracts.ServerManager~getSessionsCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getSessions = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getSessions', callback);
};
/**
 * @callback module:core/abstracts.ServerManager~getSessionsCallback
 * @param {external:Error} error
 * @param {external:String} result
 */


/**
 * @alias module:core/abstracts.ServerManager.constructorParams
 */
ServerManager.constructorParams = {};

/**
 * @alias module:core/abstracts.ServerManager.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
ServerManager.events = MediaObject.events.concat(['ObjectCreated', 'ObjectDestroyed']);


/**
 * Checker for {@link core/abstracts.ServerManager}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.ServerManager} value
 */
function checkServerManager(key, value)
{
  if(!(value instanceof ServerManager))
    throw ChecktypeError(key, ServerManager, value);
};


module.exports = ServerManager;

ServerManager.check = checkServerManager;

},{"./MediaObject":49,"inherits":40,"kurento-client":"kurento-client"}],52:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Endpoint = require('./Endpoint');


/**
 * @classdesc
 *  Session based endpoint. A session is considered to be started when the media
 *
 * @abstract
 * @extends module:core/abstracts.Endpoint
 *
 * @constructor module:core/abstracts.SessionEndpoint
 *
 * @fires {@link module:core#event:MediaSessionStarted MediaSessionStarted}
 * @fires {@link module:core#event:MediaSessionTerminated MediaSessionTerminated}
 */
function SessionEndpoint(){
  SessionEndpoint.super_.call(this);
};
inherits(SessionEndpoint, Endpoint);


/**
 * @alias module:core/abstracts.SessionEndpoint.constructorParams
 */
SessionEndpoint.constructorParams = {};

/**
 * @alias module:core/abstracts.SessionEndpoint.events
 *
 * @extends module:core/abstracts.Endpoint.events
 */
SessionEndpoint.events = Endpoint.events.concat(['MediaSessionStarted', 'MediaSessionTerminated']);


/**
 * Checker for {@link core/abstracts.SessionEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.SessionEndpoint} value
 */
function checkSessionEndpoint(key, value)
{
  if(!(value instanceof SessionEndpoint))
    throw ChecktypeError(key, SessionEndpoint, value);
};


module.exports = SessionEndpoint;

SessionEndpoint.check = checkSessionEndpoint;

},{"./Endpoint":45,"inherits":40,"kurento-client":"kurento-client"}],53:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Endpoint = require('./Endpoint');


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Interface for endpoints the require a URI to work. An example of this, would
 *
 * @abstract
 * @extends module:core/abstracts.Endpoint
 *
 * @constructor module:core/abstracts.UriEndpoint
 */
function UriEndpoint(){
  UriEndpoint.super_.call(this);
};
inherits(UriEndpoint, Endpoint);


//
// Public properties
//

/**
 * The uri for this endpoint.
 *
 * @alias module:core/abstracts.UriEndpoint#getUri
 *
 * @param {module:core/abstracts.UriEndpoint~getUriCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.getUri = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getUri', callback);
};
/**
 * @callback module:core/abstracts.UriEndpoint~getUriCallback
 * @param {external:Error} error
 * @param {external:String} result
 */


//
// Public methods
//


/**
 * Pauses the feed
 *
 * @alias module:core/abstracts.UriEndpoint.pause
 *
 * @param {module:core/abstracts.UriEndpoint~pauseCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.pause = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'pause', callback);
};
/**
 * @callback module:core/abstracts.UriEndpoint~pauseCallback
 * @param {external:Error} error
 */

/**
 * Stops the feed
 *
 * @alias module:core/abstracts.UriEndpoint.stop
 *
 * @param {module:core/abstracts.UriEndpoint~stopCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.stop = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'stop', callback);
};
/**
 * @callback module:core/abstracts.UriEndpoint~stopCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core/abstracts.UriEndpoint.constructorParams
 */
UriEndpoint.constructorParams = {};

/**
 * @alias module:core/abstracts.UriEndpoint.events
 *
 * @extends module:core/abstracts.Endpoint.events
 */
UriEndpoint.events = Endpoint.events;


/**
 * Checker for {@link core/abstracts.UriEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.UriEndpoint} value
 */
function checkUriEndpoint(key, value)
{
  if(!(value instanceof UriEndpoint))
    throw ChecktypeError(key, UriEndpoint, value);
};


module.exports = UriEndpoint;

UriEndpoint.check = checkUriEndpoint;

},{"./Endpoint":45,"inherits":40,"kurento-client":"kurento-client"}],54:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core/abstracts
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

var BaseRtpEndpoint = require('./BaseRtpEndpoint');
var Endpoint = require('./Endpoint');
var Filter = require('./Filter');
var Hub = require('./Hub');
var MediaElement = require('./MediaElement');
var MediaObject = require('./MediaObject');
var SdpEndpoint = require('./SdpEndpoint');
var ServerManager = require('./ServerManager');
var SessionEndpoint = require('./SessionEndpoint');
var UriEndpoint = require('./UriEndpoint');


exports.BaseRtpEndpoint = BaseRtpEndpoint;
exports.Endpoint = Endpoint;
exports.Filter = Filter;
exports.Hub = Hub;
exports.MediaElement = MediaElement;
exports.MediaObject = MediaObject;
exports.SdpEndpoint = SdpEndpoint;
exports.ServerManager = ServerManager;
exports.SessionEndpoint = SessionEndpoint;
exports.UriEndpoint = UriEndpoint;

},{"./BaseRtpEndpoint":44,"./Endpoint":45,"./Filter":46,"./Hub":47,"./MediaElement":48,"./MediaObject":49,"./SdpEndpoint":50,"./ServerManager":51,"./SessionEndpoint":52,"./UriEndpoint":53}],55:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Format for audio media
 *
 * @constructor module:core/complexTypes.AudioCaps
 *
 * @property {module:core/complexTypes.AudioCodec} codec
 *  Audio codec
 * @property {external:Integer} bitrate
 *  Bitrate
 */
function AudioCaps(audioCapsDict){
  if(!(this instanceof AudioCaps))
    return new AudioCaps(audioCapsDict)

  // Check audioCapsDict has the required fields
  checkType('AudioCodec', 'audioCapsDict.codec', audioCapsDict.codec, true);
  checkType('int', 'audioCapsDict.bitrate', audioCapsDict.bitrate, true);

  // Init parent class
  AudioCaps.super_.call(this, audioCapsDict)

  // Set object properties
  Object.defineProperties(this, {
    codec: {
      writable: true,
      enumerable: true,
      value: audioCapsDict.codec
    },
    bitrate: {
      writable: true,
      enumerable: true,
      value: audioCapsDict.bitrate
    }
  })
}
inherits(AudioCaps, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(AudioCaps.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "AudioCaps"
  }
})

/**
 * Checker for {@link core/complexTypes.AudioCaps}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.AudioCaps} value
 */
function checkAudioCaps(key, value)
{
  if(!(value instanceof AudioCaps))
    throw ChecktypeError(key, AudioCaps, value);
};


module.exports = AudioCaps;

AudioCaps.check = checkAudioCaps;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],56:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Codec used for transmission of audio.
 *
 * @typedef core/complexTypes.AudioCodec
 *
 * @type {(OPUS|PCMU|RAW)}
 */

/**
 * Checker for {@link core/complexTypes.AudioCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.AudioCodec} value
 */
function checkAudioCodec(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('OPUS|PCMU|RAW'))
    throw SyntaxError(key+' param is not one of [OPUS|PCMU|RAW] ('+value+')');
};


module.exports = checkAudioCodec;

},{"kurento-client":"kurento-client"}],57:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var ChecktypeError = require('kurento-client').checkType.ChecktypeError;


/**
 * @constructor module:core/complexTypes.ComplexType
 *
 * @abstract
 */
function ComplexType(){}

// Based on http://stackoverflow.com/a/14078260/586382
ComplexType.prototype.toJSON = function()
{
  var result = {};

  for(var key in this)
  {
    var value = this[key]

    if(typeof value !== 'function')
      result[key] = value;
  }

  return result;
}


/**
 * Checker for {@link core/complexTypes.ComplexType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ComplexType} value
 */
function checkComplexType(key, value)
{
  if(!(value instanceof ComplexType))
    throw ChecktypeError(key, ComplexType, value);
};


module.exports = ComplexType;

ComplexType.check = checkComplexType;

},{"kurento-client":"kurento-client"}],58:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * @constructor module:core/complexTypes.ElementConnectionData
 *
 * @property {module:core/abstracts.MediaElement} source
 *  The source element in the connection
 * @property {module:core/abstracts.MediaElement} sink
 *  The sink element in the connection
 * @property {module:core/complexTypes.MediaType} type
 *  MediaType of the connection
 * @property {external:String} sourceDescription
 *  Description of source media. Could be emty.
 * @property {external:String} sinkDescription
 *  Description of sink media. Could be emty.
 */
function ElementConnectionData(elementConnectionDataDict){
  if(!(this instanceof ElementConnectionData))
    return new ElementConnectionData(elementConnectionDataDict)

  // Check elementConnectionDataDict has the required fields
  checkType('MediaElement', 'elementConnectionDataDict.source', elementConnectionDataDict.source, true);
  checkType('MediaElement', 'elementConnectionDataDict.sink', elementConnectionDataDict.sink, true);
  checkType('MediaType', 'elementConnectionDataDict.type', elementConnectionDataDict.type, true);
  checkType('String', 'elementConnectionDataDict.sourceDescription', elementConnectionDataDict.sourceDescription, true);
  checkType('String', 'elementConnectionDataDict.sinkDescription', elementConnectionDataDict.sinkDescription, true);

  // Init parent class
  ElementConnectionData.super_.call(this, elementConnectionDataDict)

  // Set object properties
  Object.defineProperties(this, {
    source: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.source
    },
    sink: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sink
    },
    type: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.type
    },
    sourceDescription: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sourceDescription
    },
    sinkDescription: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sinkDescription
    }
  })
}
inherits(ElementConnectionData, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ElementConnectionData.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ElementConnectionData"
  }
})

/**
 * Checker for {@link core/complexTypes.ElementConnectionData}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ElementConnectionData} value
 */
function checkElementConnectionData(key, value)
{
  if(!(value instanceof ElementConnectionData))
    throw ChecktypeError(key, ElementConnectionData, value);
};


module.exports = ElementConnectionData;

ElementConnectionData.check = checkElementConnectionData;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],59:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Type of filter to be created.
 * Can take the values AUDIO, VIDEO or AUTODETECT.
 *
 * @typedef core/complexTypes.FilterType
 *
 * @type {(AUDIO|AUTODETECT|VIDEO)}
 */

/**
 * Checker for {@link core/complexTypes.FilterType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.FilterType} value
 */
function checkFilterType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('AUDIO|AUTODETECT|VIDEO'))
    throw SyntaxError(key+' param is not one of [AUDIO|AUTODETECT|VIDEO] ('+value+')');
};


module.exports = checkFilterType;

},{"kurento-client":"kurento-client"}],60:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Type that represents a fraction of an integer numerator over an integer
 * denominator
 *
 * @constructor module:core/complexTypes.Fraction
 *
 * @property {external:Integer} numerator
 *  the numerator of the fraction
 * @property {external:Integer} denominator
 *  the denominator of the fraction
 */
function Fraction(fractionDict){
  if(!(this instanceof Fraction))
    return new Fraction(fractionDict)

  // Check fractionDict has the required fields
  checkType('int', 'fractionDict.numerator', fractionDict.numerator, true);
  checkType('int', 'fractionDict.denominator', fractionDict.denominator, true);

  // Init parent class
  Fraction.super_.call(this, fractionDict)

  // Set object properties
  Object.defineProperties(this, {
    numerator: {
      writable: true,
      enumerable: true,
      value: fractionDict.numerator
    },
    denominator: {
      writable: true,
      enumerable: true,
      value: fractionDict.denominator
    }
  })
}
inherits(Fraction, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(Fraction.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "Fraction"
  }
})

/**
 * Checker for {@link core/complexTypes.Fraction}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.Fraction} value
 */
function checkFraction(key, value)
{
  if(!(value instanceof Fraction))
    throw ChecktypeError(key, Fraction, value);
};


module.exports = Fraction;

Fraction.check = checkFraction;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],61:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Details of gstreamer dot graphs
 *
 * @typedef core/complexTypes.GstreamerDotDetails
 *
 * @type {(SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_ALL)}
 */

/**
 * Checker for {@link core/complexTypes.GstreamerDotDetails}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.GstreamerDotDetails} value
 */
function checkGstreamerDotDetails(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_ALL'))
    throw SyntaxError(key+' param is not one of [SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_ALL] ('+value+')');
};


module.exports = checkGstreamerDotDetails;

},{"kurento-client":"kurento-client"}],62:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * State of the media.
 *
 * @typedef core/complexTypes.MediaState
 *
 * @type {(DISCONNECTED|CONNECTED)}
 */

/**
 * Checker for {@link core/complexTypes.MediaState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaState} value
 */
function checkMediaState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('DISCONNECTED|CONNECTED'))
    throw SyntaxError(key+' param is not one of [DISCONNECTED|CONNECTED] ('+value+')');
};


module.exports = checkMediaState;

},{"kurento-client":"kurento-client"}],63:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Type of media stream to be exchanged.
 * Can take the values AUDIO, DATA or VIDEO.
 *
 * @typedef core/complexTypes.MediaType
 *
 * @type {(AUDIO|DATA|VIDEO)}
 */

/**
 * Checker for {@link core/complexTypes.MediaType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaType} value
 */
function checkMediaType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('AUDIO|DATA|VIDEO'))
    throw SyntaxError(key+' param is not one of [AUDIO|DATA|VIDEO] ('+value+')');
};


module.exports = checkMediaType;

},{"kurento-client":"kurento-client"}],64:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Description of a loaded modules
 *
 * @constructor module:core/complexTypes.ModuleInfo
 *
 * @property {external:String} version
 *  Module version
 * @property {external:String} name
 *  Module name
 * @property {external:String} factories
 *  Module available factories
 */
function ModuleInfo(moduleInfoDict){
  if(!(this instanceof ModuleInfo))
    return new ModuleInfo(moduleInfoDict)

  // Check moduleInfoDict has the required fields
  checkType('String', 'moduleInfoDict.version', moduleInfoDict.version, true);
  checkType('String', 'moduleInfoDict.name', moduleInfoDict.name, true);
  checkType('String', 'moduleInfoDict.factories', moduleInfoDict.factories, true);

  // Init parent class
  ModuleInfo.super_.call(this, moduleInfoDict)

  // Set object properties
  Object.defineProperties(this, {
    version: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.version
    },
    name: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.name
    },
    factories: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.factories
    }
  })
}
inherits(ModuleInfo, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ModuleInfo.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ModuleInfo"
  }
})

/**
 * Checker for {@link core/complexTypes.ModuleInfo}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ModuleInfo} value
 */
function checkModuleInfo(key, value)
{
  if(!(value instanceof ModuleInfo))
    throw ChecktypeError(key, ModuleInfo, value);
};


module.exports = ModuleInfo;

ModuleInfo.check = checkModuleInfo;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],65:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCCertificateStats
 *
 * @property {external:String} fingerprint
 *  Only use the fingerprint value as defined in Section 5 of [RFC4572].
 * @property {external:String} fingerprintAlgorithm
 *  For instance, 'sha-256'.
 * @property {external:String} base64Certificate
 *  For example, DER-encoded, base-64 representation of a certifiate.
 * @property {external:String} issuerCertificateId

 * @extends module:core.RTCStats
 */
function RTCCertificateStats(rTCCertificateStatsDict){
  if(!(this instanceof RTCCertificateStats))
    return new RTCCertificateStats(rTCCertificateStatsDict)

  // Check rTCCertificateStatsDict has the required fields
  checkType('String', 'rTCCertificateStatsDict.fingerprint', rTCCertificateStatsDict.fingerprint, true);
  checkType('String', 'rTCCertificateStatsDict.fingerprintAlgorithm', rTCCertificateStatsDict.fingerprintAlgorithm, true);
  checkType('String', 'rTCCertificateStatsDict.base64Certificate', rTCCertificateStatsDict.base64Certificate, true);
  checkType('String', 'rTCCertificateStatsDict.issuerCertificateId', rTCCertificateStatsDict.issuerCertificateId, true);

  // Init parent class
  RTCCertificateStats.super_.call(this, rTCCertificateStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    fingerprint: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.fingerprint
    },
    fingerprintAlgorithm: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.fingerprintAlgorithm
    },
    base64Certificate: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.base64Certificate
    },
    issuerCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.issuerCertificateId
    }
  })
}
inherits(RTCCertificateStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCCertificateStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCCertificateStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCCertificateStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCCertificateStats} value
 */
function checkRTCCertificateStats(key, value)
{
  if(!(value instanceof RTCCertificateStats))
    throw ChecktypeError(key, RTCCertificateStats, value);
};


module.exports = RTCCertificateStats;

RTCCertificateStats.check = checkRTCCertificateStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],66:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * RTC codec statistics
 *
 * @constructor module:core/complexTypes.RTCCodec
 *
 * @property {external:Integer} payloadType
 *  Payload type as used in RTP encoding.
 * @property {external:String} codec
 *  e.g., video/vp8 or equivalent.
 * @property {external:Integer} clockRate
 *  Represents the media sampling rate.
 * @property {external:Integer} channels
 *  Use 2 for stereo, missing for most other cases.
 * @property {external:String} parameters
 *  From the SDP description line.

 * @extends module:core.RTCStats
 */
function RTCCodec(rTCCodecDict){
  if(!(this instanceof RTCCodec))
    return new RTCCodec(rTCCodecDict)

  // Check rTCCodecDict has the required fields
  checkType('int', 'rTCCodecDict.payloadType', rTCCodecDict.payloadType, true);
  checkType('String', 'rTCCodecDict.codec', rTCCodecDict.codec, true);
  checkType('int', 'rTCCodecDict.clockRate', rTCCodecDict.clockRate, true);
  checkType('int', 'rTCCodecDict.channels', rTCCodecDict.channels, true);
  checkType('String', 'rTCCodecDict.parameters', rTCCodecDict.parameters, true);

  // Init parent class
  RTCCodec.super_.call(this, rTCCodecDict)

  // Set object properties
  Object.defineProperties(this, {
    payloadType: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.payloadType
    },
    codec: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.codec
    },
    clockRate: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.clockRate
    },
    channels: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.channels
    },
    parameters: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.parameters
    }
  })
}
inherits(RTCCodec, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCCodec.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCCodec"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCCodec} value
 */
function checkRTCCodec(key, value)
{
  if(!(value instanceof RTCCodec))
    throw ChecktypeError(key, RTCCodec, value);
};


module.exports = RTCCodec;

RTCCodec.check = checkRTCCodec;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],67:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Represents the state of the RTCDataChannel
 *
 * @typedef core/complexTypes.RTCDataChannelState
 *
 * @type {(connecting|open|closing|closed)}
 */

/**
 * Checker for {@link core/complexTypes.RTCDataChannelState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCDataChannelState} value
 */
function checkRTCDataChannelState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('connecting|open|closing|closed'))
    throw SyntaxError(key+' param is not one of [connecting|open|closing|closed] ('+value+')');
};


module.exports = checkRTCDataChannelState;

},{"kurento-client":"kurento-client"}],68:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to RTC data channels.
 *
 * @constructor module:core/complexTypes.RTCDataChannelStats
 *
 * @property {external:String} label
 *  The RTCDatachannel label.
 * @property {external:String} protocol
 *  The protocol used.
 * @property {external:Integer} datachannelid
 *  The RTCDatachannel identifier.
 * @property {module:core/complexTypes.RTCDataChannelState} state
 *  The state of the RTCDatachannel.
 * @property {external:Integer} messagesSent
 *  Represents the total number of API 'message' events sent.
 * @property {external:Integer} bytesSent
 *  Represents the total number of payload bytes sent on this RTCDatachannel,
 *  i.e., not including headers or padding.
 * @property {external:Integer} messagesReceived
 *  Represents the total number of API 'message' events received.
 * @property {external:Integer} bytesReceived
 *  Represents the total number of bytes received on this RTCDatachannel, i.e.,
 *  not including headers or padding.

 * @extends module:core.RTCStats
 */
function RTCDataChannelStats(rTCDataChannelStatsDict){
  if(!(this instanceof RTCDataChannelStats))
    return new RTCDataChannelStats(rTCDataChannelStatsDict)

  // Check rTCDataChannelStatsDict has the required fields
  checkType('String', 'rTCDataChannelStatsDict.label', rTCDataChannelStatsDict.label, true);
  checkType('String', 'rTCDataChannelStatsDict.protocol', rTCDataChannelStatsDict.protocol, true);
  checkType('int', 'rTCDataChannelStatsDict.datachannelid', rTCDataChannelStatsDict.datachannelid, true);
  checkType('RTCDataChannelState', 'rTCDataChannelStatsDict.state', rTCDataChannelStatsDict.state, true);
  checkType('int', 'rTCDataChannelStatsDict.messagesSent', rTCDataChannelStatsDict.messagesSent, true);
  checkType('int', 'rTCDataChannelStatsDict.bytesSent', rTCDataChannelStatsDict.bytesSent, true);
  checkType('int', 'rTCDataChannelStatsDict.messagesReceived', rTCDataChannelStatsDict.messagesReceived, true);
  checkType('int', 'rTCDataChannelStatsDict.bytesReceived', rTCDataChannelStatsDict.bytesReceived, true);

  // Init parent class
  RTCDataChannelStats.super_.call(this, rTCDataChannelStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    label: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.label
    },
    protocol: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.protocol
    },
    datachannelid: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.datachannelid
    },
    state: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.state
    },
    messagesSent: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.messagesSent
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.bytesSent
    },
    messagesReceived: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.messagesReceived
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.bytesReceived
    }
  })
}
inherits(RTCDataChannelStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCDataChannelStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCDataChannelStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCDataChannelStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCDataChannelStats} value
 */
function checkRTCDataChannelStats(key, value)
{
  if(!(value instanceof RTCDataChannelStats))
    throw ChecktypeError(key, RTCDataChannelStats, value);
};


module.exports = RTCDataChannelStats;

RTCDataChannelStats.check = checkRTCDataChannelStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],69:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCIceCandidateAttributes
 *
 * @property {external:String} ipAddress
 *  It is the IP address of the candidate, allowing for IPv4 addresses, IPv6
 *  addresses, and fully qualified domain names (FQDNs).
 * @property {external:Integer} portNumber
 *  It is the port number of the candidate.
 * @property {external:String} transport
 *  Valid values for transport is one of udp and tcp. Based on the 'transport'
 *  defined in [RFC5245] section 15.1.
 * @property {module:core/complexTypes.RTCStatsIceCandidateType} candidateType
 *  The enumeration RTCStatsIceCandidateType is based on the cand-type defined
 *  in [RFC5245] section 15.1.
 * @property {external:Integer} priority
 *  Represents the priority of the candidate
 * @property {external:String} addressSourceUrl
 *  The URL of the TURN or STUN server indicated in the RTCIceServers that
 *  translated this IP address.

 * @extends module:core.RTCStats
 */
function RTCIceCandidateAttributes(rTCIceCandidateAttributesDict){
  if(!(this instanceof RTCIceCandidateAttributes))
    return new RTCIceCandidateAttributes(rTCIceCandidateAttributesDict)

  // Check rTCIceCandidateAttributesDict has the required fields
  checkType('String', 'rTCIceCandidateAttributesDict.ipAddress', rTCIceCandidateAttributesDict.ipAddress, true);
  checkType('int', 'rTCIceCandidateAttributesDict.portNumber', rTCIceCandidateAttributesDict.portNumber, true);
  checkType('String', 'rTCIceCandidateAttributesDict.transport', rTCIceCandidateAttributesDict.transport, true);
  checkType('RTCStatsIceCandidateType', 'rTCIceCandidateAttributesDict.candidateType', rTCIceCandidateAttributesDict.candidateType, true);
  checkType('int', 'rTCIceCandidateAttributesDict.priority', rTCIceCandidateAttributesDict.priority, true);
  checkType('String', 'rTCIceCandidateAttributesDict.addressSourceUrl', rTCIceCandidateAttributesDict.addressSourceUrl, true);

  // Init parent class
  RTCIceCandidateAttributes.super_.call(this, rTCIceCandidateAttributesDict)

  // Set object properties
  Object.defineProperties(this, {
    ipAddress: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.ipAddress
    },
    portNumber: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.portNumber
    },
    transport: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.transport
    },
    candidateType: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.candidateType
    },
    priority: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.priority
    },
    addressSourceUrl: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.addressSourceUrl
    }
  })
}
inherits(RTCIceCandidateAttributes, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCIceCandidateAttributes.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCIceCandidateAttributes"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCIceCandidateAttributes}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCIceCandidateAttributes} value
 */
function checkRTCIceCandidateAttributes(key, value)
{
  if(!(value instanceof RTCIceCandidateAttributes))
    throw ChecktypeError(key, RTCIceCandidateAttributes, value);
};


module.exports = RTCIceCandidateAttributes;

RTCIceCandidateAttributes.check = checkRTCIceCandidateAttributes;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],70:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCIceCandidatePairStats
 *
 * @property {external:String} transportId
 *  It is a unique identifier that is associated to the object that was
 *  inspected to produce the RTCTransportStats associated with this candidate
 *  pair.
 * @property {external:String} localCandidateId
 *  It is a unique identifier that is associated to the object that was
 *  inspected to produce the RTCIceCandidateAttributes for the local candidate
 *  associated with this candidate pair.
 * @property {external:String} remoteCandidateId
 *  It is a unique identifier that is associated to the object that was
 *  inspected to produce the RTCIceCandidateAttributes for the remote candidate
 *  associated with this candidate pair.
 * @property {module:core/complexTypes.RTCStatsIceCandidatePairState} state
 *  Represents the state of the checklist for the local and remote candidates in
 * @property {external:Integer} priority
 *  Calculated from candidate priorities as defined in [RFC5245] section 5.7.2.
 * @property {external:Boolean} nominated
 *  Related to updating the nominated flag described in Section 7.1.3.2.4 of
 *  [RFC5245].
 * @property {external:Boolean} writable
 *  Has gotten ACK to an ICE request.
 * @property {external:Boolean} readable
 *  Has gotten a valid incoming ICE request.
 * @property {external:Integer} bytesSent
 *  Represents the total number of payload bytes sent on this candidate pair,
 *  i.e., not including headers or padding.
 * @property {external:Integer} bytesReceived
 *  Represents the total number of payload bytes received on this candidate
 *  pair, i.e., not including headers or padding.
 * @property {external:Number} roundTripTime
 *  Represents the RTT computed by the STUN connectivity checks
 * @property {external:Number} availableOutgoingBitrate
 *  Measured in Bits per second, and is implementation dependent. It may be
 *  calculated by the underlying congestion control.
 * @property {external:Number} availableIncomingBitrate
 *  Measured in Bits per second, and is implementation dependent. It may be
 *  calculated by the underlying congestion control.

 * @extends module:core.RTCStats
 */
function RTCIceCandidatePairStats(rTCIceCandidatePairStatsDict){
  if(!(this instanceof RTCIceCandidatePairStats))
    return new RTCIceCandidatePairStats(rTCIceCandidatePairStatsDict)

  // Check rTCIceCandidatePairStatsDict has the required fields
  checkType('String', 'rTCIceCandidatePairStatsDict.transportId', rTCIceCandidatePairStatsDict.transportId, true);
  checkType('String', 'rTCIceCandidatePairStatsDict.localCandidateId', rTCIceCandidatePairStatsDict.localCandidateId, true);
  checkType('String', 'rTCIceCandidatePairStatsDict.remoteCandidateId', rTCIceCandidatePairStatsDict.remoteCandidateId, true);
  checkType('RTCStatsIceCandidatePairState', 'rTCIceCandidatePairStatsDict.state', rTCIceCandidatePairStatsDict.state, true);
  checkType('int', 'rTCIceCandidatePairStatsDict.priority', rTCIceCandidatePairStatsDict.priority, true);
  checkType('boolean', 'rTCIceCandidatePairStatsDict.nominated', rTCIceCandidatePairStatsDict.nominated, true);
  checkType('boolean', 'rTCIceCandidatePairStatsDict.writable', rTCIceCandidatePairStatsDict.writable, true);
  checkType('boolean', 'rTCIceCandidatePairStatsDict.readable', rTCIceCandidatePairStatsDict.readable, true);
  checkType('int', 'rTCIceCandidatePairStatsDict.bytesSent', rTCIceCandidatePairStatsDict.bytesSent, true);
  checkType('int', 'rTCIceCandidatePairStatsDict.bytesReceived', rTCIceCandidatePairStatsDict.bytesReceived, true);
  checkType('float', 'rTCIceCandidatePairStatsDict.roundTripTime', rTCIceCandidatePairStatsDict.roundTripTime, true);
  checkType('float', 'rTCIceCandidatePairStatsDict.availableOutgoingBitrate', rTCIceCandidatePairStatsDict.availableOutgoingBitrate, true);
  checkType('float', 'rTCIceCandidatePairStatsDict.availableIncomingBitrate', rTCIceCandidatePairStatsDict.availableIncomingBitrate, true);

  // Init parent class
  RTCIceCandidatePairStats.super_.call(this, rTCIceCandidatePairStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    transportId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.transportId
    },
    localCandidateId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.localCandidateId
    },
    remoteCandidateId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.remoteCandidateId
    },
    state: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.state
    },
    priority: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.priority
    },
    nominated: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.nominated
    },
    writable: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.writable
    },
    readable: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.readable
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.bytesSent
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.bytesReceived
    },
    roundTripTime: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.roundTripTime
    },
    availableOutgoingBitrate: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.availableOutgoingBitrate
    },
    availableIncomingBitrate: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.availableIncomingBitrate
    }
  })
}
inherits(RTCIceCandidatePairStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCIceCandidatePairStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCIceCandidatePairStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCIceCandidatePairStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCIceCandidatePairStats} value
 */
function checkRTCIceCandidatePairStats(key, value)
{
  if(!(value instanceof RTCIceCandidatePairStats))
    throw ChecktypeError(key, RTCIceCandidatePairStats, value);
};


module.exports = RTCIceCandidatePairStats;

RTCIceCandidatePairStats.check = checkRTCIceCandidatePairStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],71:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCRTPStreamStats = require('./RTCRTPStreamStats');


/**
 * Statistics that represents the measurement metrics for the incoming media
 * stream.
 *
 * @constructor module:core/complexTypes.RTCInboundRTPStreamStats
 *
 * @property {external:Integer} packetsReceived
 *  Total number of RTP packets received for this SSRC.
 * @property {external:Integer} bytesReceived
 *  Total number of bytes received for this SSRC.
 * @property {external:Integer} packetsLost
 *  Total number of RTP packets lost for this SSRC.
 * @property {external:Number} jitter
 *  Packet Jitter measured in seconds for this SSRC.
 * @property {external:Number} fractionLost
 *  The fraction packet loss reported for this SSRC.

 * @extends module:core.RTCRTPStreamStats
 */
function RTCInboundRTPStreamStats(rTCInboundRTPStreamStatsDict){
  if(!(this instanceof RTCInboundRTPStreamStats))
    return new RTCInboundRTPStreamStats(rTCInboundRTPStreamStatsDict)

  // Check rTCInboundRTPStreamStatsDict has the required fields
  checkType('int', 'rTCInboundRTPStreamStatsDict.packetsReceived', rTCInboundRTPStreamStatsDict.packetsReceived, true);
  checkType('int', 'rTCInboundRTPStreamStatsDict.bytesReceived', rTCInboundRTPStreamStatsDict.bytesReceived, true);
  checkType('int', 'rTCInboundRTPStreamStatsDict.packetsLost', rTCInboundRTPStreamStatsDict.packetsLost, true);
  checkType('float', 'rTCInboundRTPStreamStatsDict.jitter', rTCInboundRTPStreamStatsDict.jitter, true);
  checkType('float', 'rTCInboundRTPStreamStatsDict.fractionLost', rTCInboundRTPStreamStatsDict.fractionLost, true);

  // Init parent class
  RTCInboundRTPStreamStats.super_.call(this, rTCInboundRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    packetsReceived: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.packetsReceived
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.bytesReceived
    },
    packetsLost: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.packetsLost
    },
    jitter: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.jitter
    },
    fractionLost: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.fractionLost
    }
  })
}
inherits(RTCInboundRTPStreamStats, RTCRTPStreamStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCInboundRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCInboundRTPStreamStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCInboundRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCInboundRTPStreamStats} value
 */
function checkRTCInboundRTPStreamStats(key, value)
{
  if(!(value instanceof RTCInboundRTPStreamStats))
    throw ChecktypeError(key, RTCInboundRTPStreamStats, value);
};


module.exports = RTCInboundRTPStreamStats;

RTCInboundRTPStreamStats.check = checkRTCInboundRTPStreamStats;

},{"./RTCRTPStreamStats":76,"inherits":40,"kurento-client":"kurento-client"}],72:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the media stream.
 *
 * @constructor module:core/complexTypes.RTCMediaStreamStats
 *
 * @property {external:String} streamIdentifier
 *  Stream identifier.
 * @property {external:String} trackIds
 *  This is the id of the stats object, not the track.id.

 * @extends module:core.RTCStats
 */
function RTCMediaStreamStats(rTCMediaStreamStatsDict){
  if(!(this instanceof RTCMediaStreamStats))
    return new RTCMediaStreamStats(rTCMediaStreamStatsDict)

  // Check rTCMediaStreamStatsDict has the required fields
  checkType('String', 'rTCMediaStreamStatsDict.streamIdentifier', rTCMediaStreamStatsDict.streamIdentifier, true);
  checkType('String', 'rTCMediaStreamStatsDict.trackIds', rTCMediaStreamStatsDict.trackIds, true);

  // Init parent class
  RTCMediaStreamStats.super_.call(this, rTCMediaStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    streamIdentifier: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamStatsDict.streamIdentifier
    },
    trackIds: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamStatsDict.trackIds
    }
  })
}
inherits(RTCMediaStreamStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCMediaStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCMediaStreamStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCMediaStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCMediaStreamStats} value
 */
function checkRTCMediaStreamStats(key, value)
{
  if(!(value instanceof RTCMediaStreamStats))
    throw ChecktypeError(key, RTCMediaStreamStats, value);
};


module.exports = RTCMediaStreamStats;

RTCMediaStreamStats.check = checkRTCMediaStreamStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],73:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the media stream.
 *
 * @constructor module:core/complexTypes.RTCMediaStreamTrackStats
 *
 * @property {external:String} trackIdentifier
 *  Represents the track.id property.
 * @property {external:Boolean} remoteSource
 *  true indicates that this is a remote source. false in other case.
 * @property {external:String} ssrcIds
 *  Synchronized sources.
 * @property {external:Integer} frameWidth
 *  Only makes sense for video media streams and represents the width of the
 *  video frame for this SSRC.
 * @property {external:Integer} frameHeight
 *  Only makes sense for video media streams and represents the height of the
 *  video frame for this SSRC.
 * @property {external:Number} framesPerSecond
 *  Only valid for video. It represents the nominal FPS value.
 * @property {external:Integer} framesSent
 *  Only valid for video. It represents the total number of frames sent for this
 * @property {external:Integer} framesReceived
 *  Only valid for video and when remoteSource is set to true. It represents the
 * @property {external:Integer} framesDecoded
 *  Only valid for video. It represents the total number of frames correctly
 *  decoded for this SSRC.
 * @property {external:Integer} framesDropped
 *  Only valid for video. The total number of frames dropped predecode or
 *  dropped because the frame missed its display deadline.
 * @property {external:Integer} framesCorrupted
 *  Only valid for video. The total number of corrupted frames that have been
 *  detected.
 * @property {external:Number} audioLevel
 *  Only valid for audio, and the value is between 0..1 (linear), where 1.0
 *  represents 0 dBov.
 * @property {external:Number} echoReturnLoss
 *  Only present on audio tracks sourced from a microphone where echo
 *  cancellation is applied. Calculated in decibels.
 * @property {external:Number} echoReturnLossEnhancement
 *  Only present on audio tracks sourced from a microphone where echo
 *  cancellation is applied.

 * @extends module:core.RTCStats
 */
function RTCMediaStreamTrackStats(rTCMediaStreamTrackStatsDict){
  if(!(this instanceof RTCMediaStreamTrackStats))
    return new RTCMediaStreamTrackStats(rTCMediaStreamTrackStatsDict)

  // Check rTCMediaStreamTrackStatsDict has the required fields
  checkType('String', 'rTCMediaStreamTrackStatsDict.trackIdentifier', rTCMediaStreamTrackStatsDict.trackIdentifier, true);
  checkType('boolean', 'rTCMediaStreamTrackStatsDict.remoteSource', rTCMediaStreamTrackStatsDict.remoteSource, true);
  checkType('String', 'rTCMediaStreamTrackStatsDict.ssrcIds', rTCMediaStreamTrackStatsDict.ssrcIds, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.frameWidth', rTCMediaStreamTrackStatsDict.frameWidth, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.frameHeight', rTCMediaStreamTrackStatsDict.frameHeight, true);
  checkType('float', 'rTCMediaStreamTrackStatsDict.framesPerSecond', rTCMediaStreamTrackStatsDict.framesPerSecond, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.framesSent', rTCMediaStreamTrackStatsDict.framesSent, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.framesReceived', rTCMediaStreamTrackStatsDict.framesReceived, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.framesDecoded', rTCMediaStreamTrackStatsDict.framesDecoded, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.framesDropped', rTCMediaStreamTrackStatsDict.framesDropped, true);
  checkType('int', 'rTCMediaStreamTrackStatsDict.framesCorrupted', rTCMediaStreamTrackStatsDict.framesCorrupted, true);
  checkType('float', 'rTCMediaStreamTrackStatsDict.audioLevel', rTCMediaStreamTrackStatsDict.audioLevel, true);
  checkType('float', 'rTCMediaStreamTrackStatsDict.echoReturnLoss', rTCMediaStreamTrackStatsDict.echoReturnLoss, true);
  checkType('float', 'rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement', rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement, true);

  // Init parent class
  RTCMediaStreamTrackStats.super_.call(this, rTCMediaStreamTrackStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    trackIdentifier: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.trackIdentifier
    },
    remoteSource: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.remoteSource
    },
    ssrcIds: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.ssrcIds
    },
    frameWidth: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.frameWidth
    },
    frameHeight: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.frameHeight
    },
    framesPerSecond: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesPerSecond
    },
    framesSent: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesSent
    },
    framesReceived: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesReceived
    },
    framesDecoded: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesDecoded
    },
    framesDropped: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesDropped
    },
    framesCorrupted: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesCorrupted
    },
    audioLevel: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.audioLevel
    },
    echoReturnLoss: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.echoReturnLoss
    },
    echoReturnLossEnhancement: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement
    }
  })
}
inherits(RTCMediaStreamTrackStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCMediaStreamTrackStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCMediaStreamTrackStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCMediaStreamTrackStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCMediaStreamTrackStats} value
 */
function checkRTCMediaStreamTrackStats(key, value)
{
  if(!(value instanceof RTCMediaStreamTrackStats))
    throw ChecktypeError(key, RTCMediaStreamTrackStats, value);
};


module.exports = RTCMediaStreamTrackStats;

RTCMediaStreamTrackStats.check = checkRTCMediaStreamTrackStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],74:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCRTPStreamStats = require('./RTCRTPStreamStats');


/**
 * Statistics that represents the measurement metrics for the outgoing media
 * stream.
 *
 * @constructor module:core/complexTypes.RTCOutboundRTPStreamStats
 *
 * @property {external:Integer} packetsSent
 *  Total number of RTP packets sent for this SSRC.
 * @property {external:Integer} bytesSent
 *  Total number of bytes sent for this SSRC.
 * @property {external:Number} targetBitrate
 *  Presently configured bitrate target of this SSRC, in bits per second.
 * @property {external:Number} roundTripTime
 *  Estimated round trip time (seconds) for this SSRC based on the RTCP
 *  timestamp.

 * @extends module:core.RTCRTPStreamStats
 */
function RTCOutboundRTPStreamStats(rTCOutboundRTPStreamStatsDict){
  if(!(this instanceof RTCOutboundRTPStreamStats))
    return new RTCOutboundRTPStreamStats(rTCOutboundRTPStreamStatsDict)

  // Check rTCOutboundRTPStreamStatsDict has the required fields
  checkType('int', 'rTCOutboundRTPStreamStatsDict.packetsSent', rTCOutboundRTPStreamStatsDict.packetsSent, true);
  checkType('int', 'rTCOutboundRTPStreamStatsDict.bytesSent', rTCOutboundRTPStreamStatsDict.bytesSent, true);
  checkType('float', 'rTCOutboundRTPStreamStatsDict.targetBitrate', rTCOutboundRTPStreamStatsDict.targetBitrate, true);
  checkType('float', 'rTCOutboundRTPStreamStatsDict.roundTripTime', rTCOutboundRTPStreamStatsDict.roundTripTime, true);

  // Init parent class
  RTCOutboundRTPStreamStats.super_.call(this, rTCOutboundRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    packetsSent: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.packetsSent
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.bytesSent
    },
    targetBitrate: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.targetBitrate
    },
    roundTripTime: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.roundTripTime
    }
  })
}
inherits(RTCOutboundRTPStreamStats, RTCRTPStreamStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCOutboundRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCOutboundRTPStreamStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCOutboundRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCOutboundRTPStreamStats} value
 */
function checkRTCOutboundRTPStreamStats(key, value)
{
  if(!(value instanceof RTCOutboundRTPStreamStats))
    throw ChecktypeError(key, RTCOutboundRTPStreamStats, value);
};


module.exports = RTCOutboundRTPStreamStats;

RTCOutboundRTPStreamStats.check = checkRTCOutboundRTPStreamStats;

},{"./RTCRTPStreamStats":76,"inherits":40,"kurento-client":"kurento-client"}],75:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the peer connection.
 *
 * @constructor module:core/complexTypes.RTCPeerConnectionStats
 *
 * @property {external:Integer} dataChannelsOpened
 *  Represents the number of unique datachannels opened.
 * @property {external:Integer} dataChannelsClosed
 *  Represents the number of unique datachannels closed.

 * @extends module:core.RTCStats
 */
function RTCPeerConnectionStats(rTCPeerConnectionStatsDict){
  if(!(this instanceof RTCPeerConnectionStats))
    return new RTCPeerConnectionStats(rTCPeerConnectionStatsDict)

  // Check rTCPeerConnectionStatsDict has the required fields
  checkType('int', 'rTCPeerConnectionStatsDict.dataChannelsOpened', rTCPeerConnectionStatsDict.dataChannelsOpened, true);
  checkType('int', 'rTCPeerConnectionStatsDict.dataChannelsClosed', rTCPeerConnectionStatsDict.dataChannelsClosed, true);

  // Init parent class
  RTCPeerConnectionStats.super_.call(this, rTCPeerConnectionStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    dataChannelsOpened: {
      writable: true,
      enumerable: true,
      value: rTCPeerConnectionStatsDict.dataChannelsOpened
    },
    dataChannelsClosed: {
      writable: true,
      enumerable: true,
      value: rTCPeerConnectionStatsDict.dataChannelsClosed
    }
  })
}
inherits(RTCPeerConnectionStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCPeerConnectionStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCPeerConnectionStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCPeerConnectionStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCPeerConnectionStats} value
 */
function checkRTCPeerConnectionStats(key, value)
{
  if(!(value instanceof RTCPeerConnectionStats))
    throw ChecktypeError(key, RTCPeerConnectionStats, value);
};


module.exports = RTCPeerConnectionStats;

RTCPeerConnectionStats.check = checkRTCPeerConnectionStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],76:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics for the RTP stream
 *
 * @constructor module:core/complexTypes.RTCRTPStreamStats
 *
 * @property {external:String} ssrc
 *  The synchronized source SSRC
 * @property {external:String} associateStatsId
 *  The associateStatsId is used for looking up the corresponding (local/remote)
 * @property {external:Boolean} isRemote
 *  false indicates that the statistics are measured locally, while true
 *  indicates that the measurements were done at the remote endpoint and
 *  reported in an RTCP RR/XR.
 * @property {external:String} mediaTrackId
 *  Track identifier.
 * @property {external:String} transportId
 *  It is a unique identifier that is associated to the object that was
 *  inspected to produce the RTCTransportStats associated with this RTP stream.
 * @property {external:String} codecId
 *  The codec identifier
 * @property {external:Integer} firCount
 *  Count the total number of Full Intra Request (FIR) packets received by the
 *  sender. This metric is only valid for video and is sent by receiver.
 * @property {external:Integer} pliCount
 *  Count the total number of Packet Loss Indication (PLI) packets received by
 *  the sender and is sent by receiver.
 * @property {external:Integer} nackCount
 *  Count the total number of Negative ACKnowledgement (NACK) packets received
 *  by the sender and is sent by receiver.
 * @property {external:Integer} sliCount
 *  Count the total number of Slice Loss Indication (SLI) packets received by
 *  the sender. This metric is only valid for video and is sent by receiver.

 * @extends module:core.RTCStats
 */
function RTCRTPStreamStats(rTCRTPStreamStatsDict){
  if(!(this instanceof RTCRTPStreamStats))
    return new RTCRTPStreamStats(rTCRTPStreamStatsDict)

  // Check rTCRTPStreamStatsDict has the required fields
  checkType('String', 'rTCRTPStreamStatsDict.ssrc', rTCRTPStreamStatsDict.ssrc, true);
  checkType('String', 'rTCRTPStreamStatsDict.associateStatsId', rTCRTPStreamStatsDict.associateStatsId, true);
  checkType('boolean', 'rTCRTPStreamStatsDict.isRemote', rTCRTPStreamStatsDict.isRemote, true);
  checkType('String', 'rTCRTPStreamStatsDict.mediaTrackId', rTCRTPStreamStatsDict.mediaTrackId, true);
  checkType('String', 'rTCRTPStreamStatsDict.transportId', rTCRTPStreamStatsDict.transportId, true);
  checkType('String', 'rTCRTPStreamStatsDict.codecId', rTCRTPStreamStatsDict.codecId, true);
  checkType('int', 'rTCRTPStreamStatsDict.firCount', rTCRTPStreamStatsDict.firCount, true);
  checkType('int', 'rTCRTPStreamStatsDict.pliCount', rTCRTPStreamStatsDict.pliCount, true);
  checkType('int', 'rTCRTPStreamStatsDict.nackCount', rTCRTPStreamStatsDict.nackCount, true);
  checkType('int', 'rTCRTPStreamStatsDict.sliCount', rTCRTPStreamStatsDict.sliCount, true);

  // Init parent class
  RTCRTPStreamStats.super_.call(this, rTCRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    ssrc: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.ssrc
    },
    associateStatsId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.associateStatsId
    },
    isRemote: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.isRemote
    },
    mediaTrackId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.mediaTrackId
    },
    transportId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.transportId
    },
    codecId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.codecId
    },
    firCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.firCount
    },
    pliCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.pliCount
    },
    nackCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.nackCount
    },
    sliCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.sliCount
    }
  })
}
inherits(RTCRTPStreamStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCRTPStreamStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCRTPStreamStats} value
 */
function checkRTCRTPStreamStats(key, value)
{
  if(!(value instanceof RTCRTPStreamStats))
    throw ChecktypeError(key, RTCRTPStreamStats, value);
};


module.exports = RTCRTPStreamStats;

RTCRTPStreamStats.check = checkRTCRTPStreamStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],77:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * An RTCStats dictionary represents the stats gathered.
 *
 * @constructor module:core/complexTypes.RTCStats
 *
 * @property {external:String} id
 *  A unique id that is associated with the object that was inspected to produce
 * @property {module:core/complexTypes.RTCStatsType} type
 *  The type of this object.
 * @property {external:double} timestamp
 *  The timestamp associated with this object. The time is relative to the UNIX
 *  epoch (Jan 1, 1970, UTC).
 */
function RTCStats(rTCStatsDict){
  if(!(this instanceof RTCStats))
    return new RTCStats(rTCStatsDict)

  // Check rTCStatsDict has the required fields
  checkType('String', 'rTCStatsDict.id', rTCStatsDict.id, true);
  checkType('RTCStatsType', 'rTCStatsDict.type', rTCStatsDict.type, true);
  checkType('double', 'rTCStatsDict.timestamp', rTCStatsDict.timestamp, true);

  // Init parent class
  RTCStats.super_.call(this, rTCStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    id: {
      writable: true,
      enumerable: true,
      value: rTCStatsDict.id
    },
    type: {
      writable: true,
      enumerable: true,
      value: rTCStatsDict.type
    },
    timestamp: {
      writable: true,
      enumerable: true,
      value: rTCStatsDict.timestamp
    }
  })
}
inherits(RTCStats, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStats} value
 */
function checkRTCStats(key, value)
{
  if(!(value instanceof RTCStats))
    throw ChecktypeError(key, RTCStats, value);
};


module.exports = RTCStats;

RTCStats.check = checkRTCStats;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],78:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Represents the state of the checklist for the local and remote candidates in
 * a pair.
 *
 * @typedef core/complexTypes.RTCStatsIceCandidatePairState
 *
 * @type {(frozen|waiting|inprogress|failed|succeeded|cancelled)}
 */

/**
 * Checker for {@link core/complexTypes.RTCStatsIceCandidatePairState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStatsIceCandidatePairState} value
 */
function checkRTCStatsIceCandidatePairState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('frozen|waiting|inprogress|failed|succeeded|cancelled'))
    throw SyntaxError(key+' param is not one of [frozen|waiting|inprogress|failed|succeeded|cancelled] ('+value+')');
};


module.exports = checkRTCStatsIceCandidatePairState;

},{"kurento-client":"kurento-client"}],79:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Types of candidates
 *
 * @typedef core/complexTypes.RTCStatsIceCandidateType
 *
 * @type {(host|serverreflexive|peerreflexive|relayed)}
 */

/**
 * Checker for {@link core/complexTypes.RTCStatsIceCandidateType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStatsIceCandidateType} value
 */
function checkRTCStatsIceCandidateType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('host|serverreflexive|peerreflexive|relayed'))
    throw SyntaxError(key+' param is not one of [host|serverreflexive|peerreflexive|relayed] ('+value+')');
};


module.exports = checkRTCStatsIceCandidateType;

},{"kurento-client":"kurento-client"}],80:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * The type of the object.
 *
 * @typedef core/complexTypes.RTCStatsType
 *
 * @type {(inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate)}
 */

/**
 * Checker for {@link core/complexTypes.RTCStatsType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStatsType} value
 */
function checkRTCStatsType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate'))
    throw SyntaxError(key+' param is not one of [inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate] ('+value+')');
};


module.exports = checkRTCStatsType;

},{"kurento-client":"kurento-client"}],81:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to RTC data channels.
 *
 * @constructor module:core/complexTypes.RTCTransportStats
 *
 * @property {external:Integer} bytesSent
 *  Represents the total number of payload bytes sent on this PeerConnection,
 *  i.e., not including headers or padding.
 * @property {external:Integer} bytesReceived
 *  Represents the total number of bytes received on this PeerConnection, i.e.,
 *  not including headers or padding.
 * @property {external:String} rtcpTransportStatsId
 *  If RTP and RTCP are not multiplexed, this is the id of the transport that
 *  gives stats for the RTCP component, and this record has only the RTP
 *  component stats.
 * @property {external:Boolean} activeConnection
 *  Set to true when transport is active.
 * @property {external:String} selectedCandidatePairId
 *  It is a unique identifier that is associated to the object that was
 *  inspected to produce the RTCIceCandidatePairStats associated with this
 *  transport.
 * @property {external:String} localCertificateId
 *  For components where DTLS is negotiated, give local certificate.
 * @property {external:String} remoteCertificateId
 *  For components where DTLS is negotiated, give remote certificate.

 * @extends module:core.RTCStats
 */
function RTCTransportStats(rTCTransportStatsDict){
  if(!(this instanceof RTCTransportStats))
    return new RTCTransportStats(rTCTransportStatsDict)

  // Check rTCTransportStatsDict has the required fields
  checkType('int', 'rTCTransportStatsDict.bytesSent', rTCTransportStatsDict.bytesSent, true);
  checkType('int', 'rTCTransportStatsDict.bytesReceived', rTCTransportStatsDict.bytesReceived, true);
  checkType('String', 'rTCTransportStatsDict.rtcpTransportStatsId', rTCTransportStatsDict.rtcpTransportStatsId, true);
  checkType('boolean', 'rTCTransportStatsDict.activeConnection', rTCTransportStatsDict.activeConnection, true);
  checkType('String', 'rTCTransportStatsDict.selectedCandidatePairId', rTCTransportStatsDict.selectedCandidatePairId, true);
  checkType('String', 'rTCTransportStatsDict.localCertificateId', rTCTransportStatsDict.localCertificateId, true);
  checkType('String', 'rTCTransportStatsDict.remoteCertificateId', rTCTransportStatsDict.remoteCertificateId, true);

  // Init parent class
  RTCTransportStats.super_.call(this, rTCTransportStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.bytesSent
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.bytesReceived
    },
    rtcpTransportStatsId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.rtcpTransportStatsId
    },
    activeConnection: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.activeConnection
    },
    selectedCandidatePairId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.selectedCandidatePairId
    },
    localCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.localCertificateId
    },
    remoteCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.remoteCertificateId
    }
  })
}
inherits(RTCTransportStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCTransportStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCTransportStats"
  }
})

/**
 * Checker for {@link core/complexTypes.RTCTransportStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCTransportStats} value
 */
function checkRTCTransportStats(key, value)
{
  if(!(value instanceof RTCTransportStats))
    throw ChecktypeError(key, RTCTransportStats, value);
};


module.exports = RTCTransportStats;

RTCTransportStats.check = checkRTCTransportStats;

},{"./RTCStats":77,"inherits":40,"kurento-client":"kurento-client"}],82:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Description of the mediaserver
 *
 * @constructor module:core/complexTypes.ServerInfo
 *
 * @property {external:String} version
 *  MediaServer version
 * @property {module:core/complexTypes.ModuleInfo} modules
 *  Descriptor of all modules loaded by the server
 * @property {module:core/complexTypes.ServerType} type
 *  Describes the type of mediaserver
 * @property {external:String} capabilities
 *  Describes the capabilities that this server supports
 */
function ServerInfo(serverInfoDict){
  if(!(this instanceof ServerInfo))
    return new ServerInfo(serverInfoDict)

  // Check serverInfoDict has the required fields
  checkType('String', 'serverInfoDict.version', serverInfoDict.version, true);
  checkType('ModuleInfo', 'serverInfoDict.modules', serverInfoDict.modules, true);
  checkType('ServerType', 'serverInfoDict.type', serverInfoDict.type, true);
  checkType('String', 'serverInfoDict.capabilities', serverInfoDict.capabilities, true);

  // Init parent class
  ServerInfo.super_.call(this, serverInfoDict)

  // Set object properties
  Object.defineProperties(this, {
    version: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.version
    },
    modules: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.modules
    },
    type: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.type
    },
    capabilities: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.capabilities
    }
  })
}
inherits(ServerInfo, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ServerInfo.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ServerInfo"
  }
})

/**
 * Checker for {@link core/complexTypes.ServerInfo}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ServerInfo} value
 */
function checkServerInfo(key, value)
{
  if(!(value instanceof ServerInfo))
    throw ChecktypeError(key, ServerInfo, value);
};


module.exports = ServerInfo;

ServerInfo.check = checkServerInfo;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],83:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Indicates if the server is a real media server or a proxy
 *
 * @typedef core/complexTypes.ServerType
 *
 * @type {(KMS|KCS)}
 */

/**
 * Checker for {@link core/complexTypes.ServerType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ServerType} value
 */
function checkServerType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('KMS|KCS'))
    throw SyntaxError(key+' param is not one of [KMS|KCS] ('+value+')');
};


module.exports = checkServerType;

},{"kurento-client":"kurento-client"}],84:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Pair key-value with info about a MediaObject
 *
 * @constructor module:core/complexTypes.Tag
 *
 * @property {external:String} key
 *  Tag key
 * @property {external:String} value
 *  Tag Value
 */
function Tag(tagDict){
  if(!(this instanceof Tag))
    return new Tag(tagDict)

  // Check tagDict has the required fields
  checkType('String', 'tagDict.key', tagDict.key, true);
  checkType('String', 'tagDict.value', tagDict.value, true);

  // Init parent class
  Tag.super_.call(this, tagDict)

  // Set object properties
  Object.defineProperties(this, {
    key: {
      writable: true,
      enumerable: true,
      value: tagDict.key
    },
    value: {
      writable: true,
      enumerable: true,
      value: tagDict.value
    }
  })
}
inherits(Tag, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(Tag.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "Tag"
  }
})

/**
 * Checker for {@link core/complexTypes.Tag}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.Tag} value
 */
function checkTag(key, value)
{
  if(!(value instanceof Tag))
    throw ChecktypeError(key, Tag, value);
};


module.exports = Tag;

Tag.check = checkTag;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],85:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Format for video media
 *
 * @constructor module:core/complexTypes.VideoCaps
 *
 * @property {module:core/complexTypes.VideoCodec} codec
 *  Video codec
 * @property {module:core/complexTypes.Fraction} framerate
 *  Framerate
 */
function VideoCaps(videoCapsDict){
  if(!(this instanceof VideoCaps))
    return new VideoCaps(videoCapsDict)

  // Check videoCapsDict has the required fields
  checkType('VideoCodec', 'videoCapsDict.codec', videoCapsDict.codec, true);
  checkType('Fraction', 'videoCapsDict.framerate', videoCapsDict.framerate, true);

  // Init parent class
  VideoCaps.super_.call(this, videoCapsDict)

  // Set object properties
  Object.defineProperties(this, {
    codec: {
      writable: true,
      enumerable: true,
      value: videoCapsDict.codec
    },
    framerate: {
      writable: true,
      enumerable: true,
      value: videoCapsDict.framerate
    }
  })
}
inherits(VideoCaps, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(VideoCaps.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "VideoCaps"
  }
})

/**
 * Checker for {@link core/complexTypes.VideoCaps}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.VideoCaps} value
 */
function checkVideoCaps(key, value)
{
  if(!(value instanceof VideoCaps))
    throw ChecktypeError(key, VideoCaps, value);
};


module.exports = VideoCaps;

VideoCaps.check = checkVideoCaps;

},{"./ComplexType":57,"inherits":40,"kurento-client":"kurento-client"}],86:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Codec used for transmission of video.
 *
 * @typedef core/complexTypes.VideoCodec
 *
 * @type {(VP8|H264|RAW)}
 */

/**
 * Checker for {@link core/complexTypes.VideoCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.VideoCodec} value
 */
function checkVideoCodec(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('VP8|H264|RAW'))
    throw SyntaxError(key+' param is not one of [VP8|H264|RAW] ('+value+')');
};


module.exports = checkVideoCodec;

},{"kurento-client":"kurento-client"}],87:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core/complexTypes
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

var ComplexType = require('./ComplexType');

var AudioCaps = require('./AudioCaps');
var AudioCodec = require('./AudioCodec');
var ElementConnectionData = require('./ElementConnectionData');
var FilterType = require('./FilterType');
var Fraction = require('./Fraction');
var GstreamerDotDetails = require('./GstreamerDotDetails');
var MediaState = require('./MediaState');
var MediaType = require('./MediaType');
var ModuleInfo = require('./ModuleInfo');
var RTCCertificateStats = require('./RTCCertificateStats');
var RTCCodec = require('./RTCCodec');
var RTCDataChannelState = require('./RTCDataChannelState');
var RTCDataChannelStats = require('./RTCDataChannelStats');
var RTCIceCandidateAttributes = require('./RTCIceCandidateAttributes');
var RTCIceCandidatePairStats = require('./RTCIceCandidatePairStats');
var RTCInboundRTPStreamStats = require('./RTCInboundRTPStreamStats');
var RTCMediaStreamStats = require('./RTCMediaStreamStats');
var RTCMediaStreamTrackStats = require('./RTCMediaStreamTrackStats');
var RTCOutboundRTPStreamStats = require('./RTCOutboundRTPStreamStats');
var RTCPeerConnectionStats = require('./RTCPeerConnectionStats');
var RTCRTPStreamStats = require('./RTCRTPStreamStats');
var RTCStats = require('./RTCStats');
var RTCStatsIceCandidatePairState = require('./RTCStatsIceCandidatePairState');
var RTCStatsIceCandidateType = require('./RTCStatsIceCandidateType');
var RTCStatsType = require('./RTCStatsType');
var RTCTransportStats = require('./RTCTransportStats');
var ServerInfo = require('./ServerInfo');
var ServerType = require('./ServerType');
var Tag = require('./Tag');
var VideoCaps = require('./VideoCaps');
var VideoCodec = require('./VideoCodec');


exports.ComplexType = ComplexType;

exports.AudioCaps = AudioCaps;
exports.AudioCodec = AudioCodec;
exports.ElementConnectionData = ElementConnectionData;
exports.FilterType = FilterType;
exports.Fraction = Fraction;
exports.GstreamerDotDetails = GstreamerDotDetails;
exports.MediaState = MediaState;
exports.MediaType = MediaType;
exports.ModuleInfo = ModuleInfo;
exports.RTCCertificateStats = RTCCertificateStats;
exports.RTCCodec = RTCCodec;
exports.RTCDataChannelState = RTCDataChannelState;
exports.RTCDataChannelStats = RTCDataChannelStats;
exports.RTCIceCandidateAttributes = RTCIceCandidateAttributes;
exports.RTCIceCandidatePairStats = RTCIceCandidatePairStats;
exports.RTCInboundRTPStreamStats = RTCInboundRTPStreamStats;
exports.RTCMediaStreamStats = RTCMediaStreamStats;
exports.RTCMediaStreamTrackStats = RTCMediaStreamTrackStats;
exports.RTCOutboundRTPStreamStats = RTCOutboundRTPStreamStats;
exports.RTCPeerConnectionStats = RTCPeerConnectionStats;
exports.RTCRTPStreamStats = RTCRTPStreamStats;
exports.RTCStats = RTCStats;
exports.RTCStatsIceCandidatePairState = RTCStatsIceCandidatePairState;
exports.RTCStatsIceCandidateType = RTCStatsIceCandidateType;
exports.RTCStatsType = RTCStatsType;
exports.RTCTransportStats = RTCTransportStats;
exports.ServerInfo = ServerInfo;
exports.ServerType = ServerType;
exports.Tag = Tag;
exports.VideoCaps = VideoCaps;
exports.VideoCodec = VideoCodec;

},{"./AudioCaps":55,"./AudioCodec":56,"./ComplexType":57,"./ElementConnectionData":58,"./FilterType":59,"./Fraction":60,"./GstreamerDotDetails":61,"./MediaState":62,"./MediaType":63,"./ModuleInfo":64,"./RTCCertificateStats":65,"./RTCCodec":66,"./RTCDataChannelState":67,"./RTCDataChannelStats":68,"./RTCIceCandidateAttributes":69,"./RTCIceCandidatePairStats":70,"./RTCInboundRTPStreamStats":71,"./RTCMediaStreamStats":72,"./RTCMediaStreamTrackStats":73,"./RTCOutboundRTPStreamStats":74,"./RTCPeerConnectionStats":75,"./RTCRTPStreamStats":76,"./RTCStats":77,"./RTCStatsIceCandidatePairState":78,"./RTCStatsIceCandidateType":79,"./RTCStatsType":80,"./RTCTransportStats":81,"./ServerInfo":82,"./ServerType":83,"./Tag":84,"./VideoCaps":85,"./VideoCodec":86}],88:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

Object.defineProperty(exports, 'name',    {value: 'core'});
Object.defineProperty(exports, 'version', {value: '6.0.0-dev'});


var HubPort = require('./HubPort');
var MediaPipeline = require('./MediaPipeline');
var PassThrough = require('./PassThrough');


exports.HubPort = HubPort;
exports.MediaPipeline = MediaPipeline;
exports.PassThrough = PassThrough;

exports.abstracts    = require('./abstracts');
exports.complexTypes = require('./complexTypes');

},{"./HubPort":41,"./MediaPipeline":42,"./PassThrough":43,"./abstracts":54,"./complexTypes":87}],89:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create for the given pipeline
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that mixes the {@link
 *  module:elements.AlphaBlending#MediaType.AUDIO} stream of its connected
 *  sources and constructs one output with {@link
 *  module:elements.AlphaBlending#MediaType.VIDEO} streams of its connected
 *  sources into its sink
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.AlphaBlending
 */
function AlphaBlending(){
  AlphaBlending.super_.call(this);
};
inherits(AlphaBlending, Hub);


//
// Public methods
//


/**
 * Sets the source port that will be the master entry to the mixer
 *
 * @alias module:elements.AlphaBlending.setMaster
 *
 * @param {module:core.HubPort} source
 *  The reference to the HubPort setting as master port
 *
 * @param {external:Integer} zOrder
 *  The order in z to draw the master image
 *
 * @param {module:elements.AlphaBlending~setMasterCallback} [callback]
 *
 * @return {external:Promise}
 */
AlphaBlending.prototype.setMaster = function(source, zOrder, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});
  checkType('int', 'zOrder', zOrder, {required: true});

  var params = {
    source: source,
    zOrder: zOrder,
  };

  return this._invoke(transaction, 'setMaster', params, callback);
};
/**
 * @callback module:elements.AlphaBlending~setMasterCallback
 * @param {external:Error} error
 */

/**
 * Configure the blending mode of one port.
 *
 * @alias module:elements.AlphaBlending.setPortProperties
 *
 * @param {external:Number} relativeX
 *  The x position relative to the master port. Values from 0 to 1 are accepted.
 *
 * @param {external:Number} relativeY
 *  The y position relative to the master port. Values from 0 to 1 are accepted.
 *
 * @param {external:Integer} zOrder
 *  The order in z to draw the images. The greatest value of z is in the top.
 *
 * @param {external:Number} relativeWidth
 *  The image width relative to the master port width. Values from 0 to 1 are
 *  accepted.
 *
 * @param {external:Number} relativeHeight
 *  The image height relative to the master port height. Values from 0 to 1 are
 *  accepted.
 *
 * @param {module:core.HubPort} port
 *  The reference to the confingured port.
 *
 * @param {module:elements.AlphaBlending~setPortPropertiesCallback} [callback]
 *
 * @return {external:Promise}
 */
AlphaBlending.prototype.setPortProperties = function(relativeX, relativeY, zOrder, relativeWidth, relativeHeight, port, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('float', 'relativeX', relativeX, {required: true});
  checkType('float', 'relativeY', relativeY, {required: true});
  checkType('int', 'zOrder', zOrder, {required: true});
  checkType('float', 'relativeWidth', relativeWidth, {required: true});
  checkType('float', 'relativeHeight', relativeHeight, {required: true});
  checkType('HubPort', 'port', port, {required: true});

  var params = {
    relativeX: relativeX,
    relativeY: relativeY,
    zOrder: zOrder,
    relativeWidth: relativeWidth,
    relativeHeight: relativeHeight,
    port: port,
  };

  return this._invoke(transaction, 'setPortProperties', params, callback);
};
/**
 * @callback module:elements.AlphaBlending~setPortPropertiesCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.AlphaBlending.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher
 *  belongs
 */
AlphaBlending.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.AlphaBlending.events
 *
 * @extends module:core/abstracts.Hub.events
 */
AlphaBlending.events = Hub.events;


/**
 * Checker for {@link elements.AlphaBlending}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.AlphaBlending} value
 */
function checkAlphaBlending(key, value)
{
  if(!(value instanceof AlphaBlending))
    throw ChecktypeError(key, AlphaBlending, value);
};


module.exports = AlphaBlending;

AlphaBlending.check = checkAlphaBlending;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],90:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Hub = require('kurento-client-core').abstracts.Hub;


/**
 * Create for the given pipeline
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that mixes the {@link
 *  module:elements.Composite#MediaType.AUDIO} stream of its connected sources
 *  and constructs a grid with the {@link
 *  module:elements.Composite#MediaType.VIDEO} streams of its connected sources
 *  into its sink
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Composite
 */
function Composite(){
  Composite.super_.call(this);
};
inherits(Composite, Hub);


/**
 * @alias module:elements.Composite.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher
 *  belongs
 */
Composite.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.Composite.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Composite.events = Hub.events;


/**
 * Checker for {@link elements.Composite}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Composite} value
 */
function checkComposite(key, value)
{
  if(!(value instanceof Composite))
    throw ChecktypeError(key, Composite, value);
};


module.exports = Composite;

Composite.check = checkComposite;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],91:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create a {@link module:elements.Dispatcher Dispatcher} belonging to the given
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that allows routing between
 *  arbitrary port pairs
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Dispatcher
 */
function Dispatcher(){
  Dispatcher.super_.call(this);
};
inherits(Dispatcher, Hub);


//
// Public methods
//


/**
 * Connects each corresponding {@link MediaType} of the given source port with
 * the sink port.
 *
 * @alias module:elements.Dispatcher.connect
 *
 * @param {module:core.HubPort} source
 *  Source port to be connected
 *
 * @param {module:core.HubPort} sink
 *  Sink port to be connected
 *
 * @param {module:elements.Dispatcher~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
Dispatcher.prototype.connect = function(source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    source: source,
    sink: sink,
  };

  var promise = this._invoke(transaction, 'connect', params, callback);

  promise.connect = sink.connect.bind(sink);

  return promise;
};
/**
 * @callback module:elements.Dispatcher~connectCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.Dispatcher.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher
 *  belongs
 */
Dispatcher.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.Dispatcher.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Dispatcher.events = Hub.events;


/**
 * Checker for {@link elements.Dispatcher}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Dispatcher} value
 */
function checkDispatcher(key, value)
{
  if(!(value instanceof Dispatcher))
    throw ChecktypeError(key, Dispatcher, value);
};


module.exports = Dispatcher;

Dispatcher.check = checkDispatcher;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],92:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create a {@link module:elements.DispatcherOneToMany DispatcherOneToMany}
 * belonging to the given pipeline.
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that sends a given source to all the
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.DispatcherOneToMany
 */
function DispatcherOneToMany(){
  DispatcherOneToMany.super_.call(this);
};
inherits(DispatcherOneToMany, Hub);


//
// Public methods
//


/**
 * Remove the source port and stop the media pipeline.
 *
 * @alias module:elements.DispatcherOneToMany.removeSource
 *
 * @param {module:elements.DispatcherOneToMany~removeSourceCallback} [callback]
 *
 * @return {external:Promise}
 */
DispatcherOneToMany.prototype.removeSource = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'removeSource', callback);
};
/**
 * @callback module:elements.DispatcherOneToMany~removeSourceCallback
 * @param {external:Error} error
 */

/**
 * Sets the source port that will be connected to the sinks of every {@link
 * module:core.HubPort HubPort} of the dispatcher
 *
 * @alias module:elements.DispatcherOneToMany.setSource
 *
 * @param {module:core.HubPort} source
 *  source to be broadcasted
 *
 * @param {module:elements.DispatcherOneToMany~setSourceCallback} [callback]
 *
 * @return {external:Promise}
 */
DispatcherOneToMany.prototype.setSource = function(source, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});

  var params = {
    source: source,
  };

  return this._invoke(transaction, 'setSource', params, callback);
};
/**
 * @callback module:elements.DispatcherOneToMany~setSourceCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.DispatcherOneToMany.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher
 *  belongs
 */
DispatcherOneToMany.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.DispatcherOneToMany.events
 *
 * @extends module:core/abstracts.Hub.events
 */
DispatcherOneToMany.events = Hub.events;


/**
 * Checker for {@link elements.DispatcherOneToMany}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.DispatcherOneToMany} value
 */
function checkDispatcherOneToMany(key, value)
{
  if(!(value instanceof DispatcherOneToMany))
    throw ChecktypeError(key, DispatcherOneToMany, value);
};


module.exports = DispatcherOneToMany;

DispatcherOneToMany.check = checkDispatcherOneToMany;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],93:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var HttpEndpoint = require('./abstracts/HttpEndpoint');


/**
 * Builder for the {@link module:elements.HttpGetEndpoint HttpGetEndpoint}.
 *
 * @classdesc
 *  An <code>HttpGetEndpoint</code> contains SOURCE pads for AUDIO and VIDEO,
 *  delivering media using HTML5 pseudo-streaming mechanism.
 *     This type of endpoint provide unidirectional communications. Its
 *     :rom:cls:`MediaSink` is associated with the HTTP GET method
 *
 * @extends module:elements/abstracts.HttpEndpoint
 *
 * @constructor module:elements.HttpGetEndpoint
 */
function HttpGetEndpoint(){
  HttpGetEndpoint.super_.call(this);
};
inherits(HttpGetEndpoint, HttpEndpoint);


/**
 * @alias module:elements.HttpGetEndpoint.constructorParams
 *
 * @property {external:Integer} [disconnectionTimeout]
 *  disconnection timeout in seconds.
 *  This is the time that an http endpoint will wait for a reconnection, in case
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint
 *  belongs
 *
 * @property {module:elements/complexTypes.MediaProfileSpecType} [mediaProfile]
 *  the {@link MediaProfileSpecType} (WEBM, MP4...) for the endpoint
 *
 * @property {external:Boolean} [terminateOnEOS]
 *  raise a :rom:evnt:`MediaSessionTerminated` event when the associated player
 *  raises a :rom:evnt:`EndOfStream`, and thus terminate the media session
 */
HttpGetEndpoint.constructorParams = {
  disconnectionTimeout: {
    type: 'int',
  },

  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },

  mediaProfile: {
    type: 'MediaProfileSpecType',
  },

  terminateOnEOS: {
    type: 'boolean',
  },
};

/**
 * @alias module:elements.HttpGetEndpoint.events
 *
 * @extends module:elements/abstracts.HttpEndpoint.events
 */
HttpGetEndpoint.events = HttpEndpoint.events;


/**
 * Checker for {@link elements.HttpGetEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.HttpGetEndpoint} value
 */
function checkHttpGetEndpoint(key, value)
{
  if(!(value instanceof HttpGetEndpoint))
    throw ChecktypeError(key, HttpGetEndpoint, value);
};


module.exports = HttpGetEndpoint;

HttpGetEndpoint.check = checkHttpGetEndpoint;

},{"./abstracts/HttpEndpoint":100,"inherits":40,"kurento-client":"kurento-client"}],94:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var HttpEndpoint = require('./abstracts/HttpEndpoint');


/**
 * Builder for the {@link module:elements.HttpPostEndpoint HttpPostEndpoint}.
 *
 * @classdesc
 *  An {@link module:elements.HttpPostEndpoint HttpPostEndpoint} contains SINK
 *  pads for AUDIO and VIDEO, which provide access to an HTTP file upload
 *  function
 *     This type of endpoint provide unidirectional communications. Its
 *     :rom:cls:`MediaSources <MediaSource>` are accessed through the <a
 *     href="http://www.kurento.org/docs/current/glossary.html#term-http">HTTP</a>
 *
 * @extends module:elements/abstracts.HttpEndpoint
 *
 * @constructor module:elements.HttpPostEndpoint
 *
 * @fires {@link module:elements#event:EndOfStream EndOfStream}
 */
function HttpPostEndpoint(){
  HttpPostEndpoint.super_.call(this);
};
inherits(HttpPostEndpoint, HttpEndpoint);


/**
 * @alias module:elements.HttpPostEndpoint.constructorParams
 *
 * @property {external:Integer} [disconnectionTimeout]
 *  This is the time that an http endpoint will wait for a reconnection, in case
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint
 *  belongs
 *
 * @property {external:Boolean} [useEncodedMedia]
 *  configures the endpoint to use encoded media instead of raw media. If the
 *  parameter is not set then the element uses raw media. Changing this
 *  parameter could affect in a severe way to stability because key frames lost
 *  will not be generated. Changing the media type does not affect to the result
 */
HttpPostEndpoint.constructorParams = {
  disconnectionTimeout: {
    type: 'int',
  },

  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },

  useEncodedMedia: {
    type: 'boolean',
  },
};

/**
 * @alias module:elements.HttpPostEndpoint.events
 *
 * @extends module:elements/abstracts.HttpEndpoint.events
 */
HttpPostEndpoint.events = HttpEndpoint.events.concat(['EndOfStream']);


/**
 * Checker for {@link elements.HttpPostEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.HttpPostEndpoint} value
 */
function checkHttpPostEndpoint(key, value)
{
  if(!(value instanceof HttpPostEndpoint))
    throw ChecktypeError(key, HttpPostEndpoint, value);
};


module.exports = HttpPostEndpoint;

HttpPostEndpoint.check = checkHttpPostEndpoint;

},{"./abstracts/HttpEndpoint":100,"inherits":40,"kurento-client":"kurento-client"}],95:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create a {@link module:elements.Mixer Mixer} belonging to the given pipeline.
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that allows routing of video between
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Mixer
 */
function Mixer(){
  Mixer.super_.call(this);
};
inherits(Mixer, Hub);


//
// Public methods
//


/**
 * Connects each corresponding {@link MediaType} of the given source port with
 * the sink port.
 *
 * @alias module:elements.Mixer.connect
 *
 * @param {external:MediaType} media
 *  The sort of media stream to be connected
 *
 * @param {module:core.HubPort} source
 *  Source port to be connected
 *
 * @param {module:core.HubPort} sink
 *  Sink port to be connected
 *
 * @param {module:elements.Mixer~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
Mixer.prototype.connect = function(media, source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('MediaType', 'media', media, {required: true});
  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    media: media,
    source: source,
    sink: sink,
  };

  var promise = this._invoke(transaction, 'connect', params, callback);

  promise.connect = sink.connect.bind(sink);

  return promise;
};
/**
 * @callback module:elements.Mixer~connectCallback
 * @param {external:Error} error
 */

/**
 * Disonnects each corresponding {@link MediaType} of the given source port from
 *
 * @alias module:elements.Mixer.disconnect
 *
 * @param {external:MediaType} media
 *  The sort of media stream to be disconnected
 *
 * @param {module:core.HubPort} source
 *  Audio source port to be disconnected
 *
 * @param {module:core.HubPort} sink
 *  Audio sink port to be disconnected
 *
 * @param {module:elements.Mixer~disconnectCallback} [callback]
 *
 * @return {external:Promise}
 */
Mixer.prototype.disconnect = function(media, source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('MediaType', 'media', media, {required: true});
  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    media: media,
    source: source,
    sink: sink,
  };

  return this._invoke(transaction, 'disconnect', params, callback);
};
/**
 * @callback module:elements.Mixer~disconnectCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.Mixer.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the Mixer
 *  belongs
 */
Mixer.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.Mixer.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Mixer.events = Hub.events;


/**
 * Checker for {@link elements.Mixer}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Mixer} value
 */
function checkMixer(key, value)
{
  if(!(value instanceof Mixer))
    throw ChecktypeError(key, Mixer, value);
};


module.exports = Mixer;

Mixer.check = checkMixer;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],96:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var UriEndpoint = require('kurento-client-core').abstracts.UriEndpoint;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Create a PlayerEndpoint
 *
 * @classdesc
 *  Retrieves content from seekable sources in reliable
 *  mode (does not discard media information) and inject
 *  them into <a
 *  href="http://www.kurento.org/docs/current/glossary.html#term-kms">KMS</a>.
 *  It
 *  contains one :rom:cls:`MediaSource` for each media type detected.
 *
 * @extends module:core/abstracts.UriEndpoint
 *
 * @constructor module:elements.PlayerEndpoint
 *
 * @fires {@link module:elements#event:EndOfStream EndOfStream}
 */
function PlayerEndpoint(){
  PlayerEndpoint.super_.call(this);
};
inherits(PlayerEndpoint, UriEndpoint);


//
// Public methods
//


/**
 * Starts to send data to the endpoint :rom:cls:`MediaSource`
 *
 * @alias module:elements.PlayerEndpoint.play
 *
 * @param {module:elements.PlayerEndpoint~playCallback} [callback]
 *
 * @return {external:Promise}
 */
PlayerEndpoint.prototype.play = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'play', callback);
};
/**
 * @callback module:elements.PlayerEndpoint~playCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.PlayerEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  The {@link module:core.MediaPipeline MediaPipeline} this PlayerEndpoint
 *  belongs to.
 *
 * @property {external:String} uri
 *  URI that will be played
 *
 * @property {external:Boolean} [useEncodedMedia]
 *  use encoded instead of raw media. If the parameter is false then the
 *  element uses raw media. Changing this parameter can affect stability
 *  severely, as lost key frames lost will not be regenerated. Changing the
 *  media type does not
 *  affect to the result except in the performance (just in the case where
 *  original media and target media are the same) and in the problem with the
 *  key frames. We strongly recommended not to use this parameter because
 *  correct behaviour is not guarantied.
 */
PlayerEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },

  uri: {
    type: 'String',
    required: true
  },

  useEncodedMedia: {
    type: 'boolean',
  },
};

/**
 * @alias module:elements.PlayerEndpoint.events
 *
 * @extends module:core/abstracts.UriEndpoint.events
 */
PlayerEndpoint.events = UriEndpoint.events.concat(['EndOfStream']);


/**
 * Checker for {@link elements.PlayerEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.PlayerEndpoint} value
 */
function checkPlayerEndpoint(key, value)
{
  if(!(value instanceof PlayerEndpoint))
    throw ChecktypeError(key, PlayerEndpoint, value);
};


module.exports = PlayerEndpoint;

PlayerEndpoint.check = checkPlayerEndpoint;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],97:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var UriEndpoint = require('kurento-client-core').abstracts.UriEndpoint;


function noop(error) {
  if (error) console.trace(error);
};


/**
 *
 * @classdesc
 *  Provides function to store contents in reliable mode (doesn't discard data).
 *
 * @extends module:core/abstracts.UriEndpoint
 *
 * @constructor module:elements.RecorderEndpoint
 */
function RecorderEndpoint(){
  RecorderEndpoint.super_.call(this);
};
inherits(RecorderEndpoint, UriEndpoint);


//
// Public methods
//


/**
 * Starts storing media received through the :rom:cls:`MediaSink` pad
 *
 * @alias module:elements.RecorderEndpoint.record
 *
 * @param {module:elements.RecorderEndpoint~recordCallback} [callback]
 *
 * @return {external:Promise}
 */
RecorderEndpoint.prototype.record = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'record', callback);
};
/**
 * @callback module:elements.RecorderEndpoint~recordCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.RecorderEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint
 *  belongs
 *
 * @property {module:elements/complexTypes.MediaProfileSpecType} [mediaProfile]
 *  Choose either a {@link
 *  module:elements.RecorderEndpoint#MediaProfileSpecType.WEBM} or a {@link
 *  module:elements.RecorderEndpoint#MediaProfileSpecType.MP4} profile for
 *  recording
 *
 * @property {external:Boolean} [stopOnEndOfStream]
 *  Forces the recorder endpoint to finish processing data when an <a
 *  href="http://www.kurento.org/docs/current/glossary.html#term-eos">EOS</a> is
 *
 * @property {external:String} uri
 *  URI where the recording will be stored
 */
RecorderEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },

  mediaProfile: {
    type: 'MediaProfileSpecType',
  },

  stopOnEndOfStream: {
    type: 'boolean',
  },

  uri: {
    type: 'String',
    required: true
  },
};

/**
 * @alias module:elements.RecorderEndpoint.events
 *
 * @extends module:core/abstracts.UriEndpoint.events
 */
RecorderEndpoint.events = UriEndpoint.events;


/**
 * Checker for {@link elements.RecorderEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.RecorderEndpoint} value
 */
function checkRecorderEndpoint(key, value)
{
  if(!(value instanceof RecorderEndpoint))
    throw ChecktypeError(key, RecorderEndpoint, value);
};


module.exports = RecorderEndpoint;

RecorderEndpoint.check = checkRecorderEndpoint;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],98:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var SdpEndpoint = require('kurento-client-core').abstracts.SdpEndpoint;


/**
 * Builder for the {@link module:elements.RtpEndpoint RtpEndpoint}
 *
 * @classdesc
 *  Endpoint that provides bidirectional content delivery capabilities with
 *  remote networked peers through RTP protocol. An {@link
 *  module:elements.RtpEndpoint RtpEndpoint} contains paired sink and source
 *  :rom:cls:`MediaPad` for audio and video.
 *
 * @extends module:core/abstracts.SdpEndpoint
 *
 * @constructor module:elements.RtpEndpoint
 */
function RtpEndpoint(){
  RtpEndpoint.super_.call(this);
};
inherits(RtpEndpoint, SdpEndpoint);


/**
 * @alias module:elements.RtpEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint
 *  belongs
 */
RtpEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.RtpEndpoint.events
 *
 * @extends module:core/abstracts.SdpEndpoint.events
 */
RtpEndpoint.events = SdpEndpoint.events;


/**
 * Checker for {@link elements.RtpEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.RtpEndpoint} value
 */
function checkRtpEndpoint(key, value)
{
  if(!(value instanceof RtpEndpoint))
    throw ChecktypeError(key, RtpEndpoint, value);
};


module.exports = RtpEndpoint;

RtpEndpoint.check = checkRtpEndpoint;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],99:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var BaseRtpEndpoint = require('kurento-client-core').abstracts.BaseRtpEndpoint;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * Builder for the {@link module:elements.WebRtcEndpoint WebRtcEndpoint}
 *
 * @classdesc
 *  WebRtcEndpoint interface. This type of <code>Endpoint</code> offers media
 *  streaming using WebRTC.
 *
 * @extends module:core/abstracts.BaseRtpEndpoint
 *
 * @constructor module:elements.WebRtcEndpoint
 *
 * @fires {@link module:elements#event:OnIceCandidate OnIceCandidate}
 * @fires {@link module:elements#event:OnIceComponentStateChanged OnIceComponentStateChanged}
 * @fires {@link module:elements#event:OnIceGatheringDone OnIceGatheringDone}
 */
function WebRtcEndpoint(){
  WebRtcEndpoint.super_.call(this);
};
inherits(WebRtcEndpoint, BaseRtpEndpoint);


//
// Public properties
//

/**
 * Address of the STUN server (Only IP address are supported)
 *
 * @alias module:elements.WebRtcEndpoint#getStunServerAddress
 *
 * @param {module:elements.WebRtcEndpoint~getStunServerAddressCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getStunServerAddress = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getStunServerAddress', callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~getStunServerAddressCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * Address of the STUN server (Only IP address are supported)
 *
 * @alias module:elements.WebRtcEndpoint#setStunServerAddress
 *
 * @param {external:String} stunServerAddress
 * @param {module:elements.WebRtcEndpoint~setStunServerAddressCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setStunServerAddress = function(stunServerAddress, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'stunServerAddress', stunServerAddress, {required: true});

  var params = {
    stunServerAddress: stunServerAddress,
  };

  return this._invoke(transaction, 'setStunServerAddress', params, callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~setStunServerAddressCallback
 * @param {external:Error} error
 */

/**
 * Port of the STUN server
 *
 * @alias module:elements.WebRtcEndpoint#getStunServerPort
 *
 * @param {module:elements.WebRtcEndpoint~getStunServerPortCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getStunServerPort = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getStunServerPort', callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~getStunServerPortCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Port of the STUN server
 *
 * @alias module:elements.WebRtcEndpoint#setStunServerPort
 *
 * @param {external:Integer} stunServerPort
 * @param {module:elements.WebRtcEndpoint~setStunServerPortCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setStunServerPort = function(stunServerPort, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'stunServerPort', stunServerPort, {required: true});

  var params = {
    stunServerPort: stunServerPort,
  };

  return this._invoke(transaction, 'setStunServerPort', params, callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~setStunServerPortCallback
 * @param {external:Error} error
 */

/**
 * TURN server URL with this format:
 * 'user:password@address:port(?transport=[udp|tcp|tls])'.
 * 'address' must be an IP (not a domain).
 * 'transport' is optional (UDP by default).
 *
 * @alias module:elements.WebRtcEndpoint#getTurnUrl
 *
 * @param {module:elements.WebRtcEndpoint~getTurnUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getTurnUrl = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return this._invoke(transaction, 'getTurnUrl', callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~getTurnUrlCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * TURN server URL with this format:
 * 'user:password@address:port(?transport=[udp|tcp|tls])'.
 * 'address' must be an IP (not a domain).
 * 'transport' is optional (UDP by default).
 *
 * @alias module:elements.WebRtcEndpoint#setTurnUrl
 *
 * @param {external:String} turnUrl
 * @param {module:elements.WebRtcEndpoint~setTurnUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setTurnUrl = function(turnUrl, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'turnUrl', turnUrl, {required: true});

  var params = {
    turnUrl: turnUrl,
  };

  return this._invoke(transaction, 'setTurnUrl', params, callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~setTurnUrlCallback
 * @param {external:Error} error
 */


//
// Public methods
//


/**
 * Provide a remote ICE candidate
 *
 * @alias module:elements.WebRtcEndpoint.addIceCandidate
 *
 * @param {module:elements/complexTypes.IceCandidate} candidate
 *  Remote ICE candidate
 *
 * @param {module:elements.WebRtcEndpoint~addIceCandidateCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.addIceCandidate = function(candidate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;
  console.log('>>> ADD ICE CANDIDATE');

  //checkType('IceCandidate', 'candidate', candidate, {required: true});

  var params = {
    candidate: candidate,
  };

  return this._invoke(transaction, 'addIceCandidate', params, callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~addIceCandidateCallback
 * @param {external:Error} error
 */

/**
 * Init the gathering of ICE candidates.
 * It must be called after SdpEndpoint::generateOffer or
 * SdpEndpoint::processOffer
 *
 * @alias module:elements.WebRtcEndpoint.gatherCandidates
 *
 * @param {module:elements.WebRtcEndpoint~gatherCandidatesCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.gatherCandidates = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'gatherCandidates', callback);
};
/**
 * @callback module:elements.WebRtcEndpoint~gatherCandidatesCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.WebRtcEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint
 *  belongs
 */
WebRtcEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:elements.WebRtcEndpoint.events
 *
 * @extends module:core/abstracts.BaseRtpEndpoint.events
 */
WebRtcEndpoint.events = BaseRtpEndpoint.events.concat(['OnIceCandidate', 'OnIceComponentStateChanged', 'OnIceGatheringDone']);


/**
 * Checker for {@link elements.WebRtcEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.WebRtcEndpoint} value
 */
function checkWebRtcEndpoint(key, value)
{
  if(!(value instanceof WebRtcEndpoint))
    throw ChecktypeError(key, WebRtcEndpoint, value);
};


module.exports = WebRtcEndpoint;

WebRtcEndpoint.check = checkWebRtcEndpoint;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],100:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var SessionEndpoint = require('kurento-client-core').abstracts.SessionEndpoint;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * @classdesc
 *  Endpoint that enables Kurento to work as an HTTP server, allowing peer HTTP
 *  clients to access media.
 *
 * @abstract
 * @extends module:core/abstracts.SessionEndpoint
 *
 * @constructor module:elements/abstracts.HttpEndpoint
 */
function HttpEndpoint(){
  HttpEndpoint.super_.call(this);
};
inherits(HttpEndpoint, SessionEndpoint);


//
// Public methods
//


/**
 * Obtains the URL associated to this endpoint
 *
 * @alias module:elements/abstracts.HttpEndpoint.getUrl
 *
 * @param {module:elements/abstracts.HttpEndpoint~getUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
HttpEndpoint.prototype.getUrl = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'getUrl', callback);
};
/**
 * @callback module:elements/abstracts.HttpEndpoint~getUrlCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The url as a String
 */


/**
 * @alias module:elements/abstracts.HttpEndpoint.constructorParams
 */
HttpEndpoint.constructorParams = {};

/**
 * @alias module:elements/abstracts.HttpEndpoint.events
 *
 * @extends module:core/abstracts.SessionEndpoint.events
 */
HttpEndpoint.events = SessionEndpoint.events;


/**
 * Checker for {@link elements/abstracts.HttpEndpoint}
 *
 * @memberof module:elements/abstracts
 *
 * @param {external:String} key
 * @param {module:elements/abstracts.HttpEndpoint} value
 */
function checkHttpEndpoint(key, value)
{
  if(!(value instanceof HttpEndpoint))
    throw ChecktypeError(key, HttpEndpoint, value);
};


module.exports = HttpEndpoint;

HttpEndpoint.check = checkHttpEndpoint;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],101:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements/abstracts
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

var HttpEndpoint = require('./HttpEndpoint');


exports.HttpEndpoint = HttpEndpoint;

},{"./HttpEndpoint":100}],102:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 * IceCandidate representation based on standard
 * (http://www.w3.org/TR/webrtc/#rtcicecandidate-type).
 *
 * @constructor module:elements/complexTypes.IceCandidate
 *
 * @property {external:String} candidate
 *  The candidate-attribute as defined in section 15.1 of ICE (rfc5245).
 * @property {external:String} sdpMid
 *  If present, this contains the identifier of the 'media stream
 *  identification'.
 * @property {external:Integer} sdpMLineIndex
 *  The index (starting at zero) of the m-line in the SDP this candidate is
 *  associated with.
 */
function IceCandidate(iceCandidateDict){
  console.log('>>> IceCand');
  if(!(this instanceof IceCandidate))
    return new IceCandidate(iceCandidateDict)

  // Check iceCandidateDict has the required fields
  checkType('String', 'iceCandidateDict.candidate', iceCandidateDict.candidate, true);
  checkType('String', 'iceCandidateDict.sdpMid', iceCandidateDict.sdpMid, true);
  checkType('int', 'iceCandidateDict.sdpMLineIndex', iceCandidateDict.sdpMLineIndex, true);

  // Init parent class
  IceCandidate.super_.call(this, iceCandidateDict)

  // Set object properties
  Object.defineProperties(this, {
    candidate: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.candidate
    },
    sdpMid: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.sdpMid
    },
    sdpMLineIndex: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.sdpMLineIndex
    }
  })
}
inherits(IceCandidate, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(IceCandidate.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "IceCandidate"
  }
})

/**
 * Checker for {@link elements/complexTypes.IceCandidate}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceCandidate} value
 */
function checkIceCandidate(key, value)
{
  if(!(value instanceof IceCandidate))
    throw ChecktypeError(key, IceCandidate, value);
};


module.exports = IceCandidate;

IceCandidate.check = checkIceCandidate;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],103:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * States of an ICE component.
 *
 * @typedef elements/complexTypes.IceComponentState
 *
 * @type {(DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED)}
 */

/**
 * Checker for {@link elements/complexTypes.IceComponentState}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceComponentState} value
 */
function checkIceComponentState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED'))
    throw SyntaxError(key+' param is not one of [DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED] ('+value+')');
};


module.exports = checkIceComponentState;

},{"kurento-client":"kurento-client"}],104:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurentoClient = require('kurento-client');



/**
 * Media Profile.
 * Currently WEBM and MP4 are supported.
 *
 * @typedef elements/complexTypes.MediaProfileSpecType
 *
 * @type {(WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY)}
 */

/**
 * Checker for {@link elements/complexTypes.MediaProfileSpecType}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.MediaProfileSpecType} value
 */
function checkMediaProfileSpecType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY'))
    throw SyntaxError(key+' param is not one of [WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY] ('+value+')');
};


module.exports = checkMediaProfileSpecType;

},{"kurento-client":"kurento-client"}],105:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements/complexTypes
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

var IceCandidate = require('./IceCandidate');
var IceComponentState = require('./IceComponentState');
var MediaProfileSpecType = require('./MediaProfileSpecType');


exports.IceCandidate = IceCandidate;
exports.IceComponentState = IceComponentState;
exports.MediaProfileSpecType = MediaProfileSpecType;

},{"./IceCandidate":102,"./IceComponentState":103,"./MediaProfileSpecType":104}],106:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

Object.defineProperty(exports, 'name',    {value: 'elements'});
Object.defineProperty(exports, 'version', {value: '6.0.0-dev'});


var AlphaBlending = require('./AlphaBlending');
var Composite = require('./Composite');
var Dispatcher = require('./Dispatcher');
var DispatcherOneToMany = require('./DispatcherOneToMany');
var HttpGetEndpoint = require('./HttpGetEndpoint');
var HttpPostEndpoint = require('./HttpPostEndpoint');
var Mixer = require('./Mixer');
var PlayerEndpoint = require('./PlayerEndpoint');
var RecorderEndpoint = require('./RecorderEndpoint');
var RtpEndpoint = require('./RtpEndpoint');
var WebRtcEndpoint = require('./WebRtcEndpoint');


exports.AlphaBlending = AlphaBlending;
exports.Composite = Composite;
exports.Dispatcher = Dispatcher;
exports.DispatcherOneToMany = DispatcherOneToMany;
exports.HttpGetEndpoint = HttpGetEndpoint;
exports.HttpPostEndpoint = HttpPostEndpoint;
exports.Mixer = Mixer;
exports.PlayerEndpoint = PlayerEndpoint;
exports.RecorderEndpoint = RecorderEndpoint;
exports.RtpEndpoint = RtpEndpoint;
exports.WebRtcEndpoint = WebRtcEndpoint;

exports.abstracts    = require('./abstracts');
exports.complexTypes = require('./complexTypes');

},{"./AlphaBlending":89,"./Composite":90,"./Dispatcher":91,"./DispatcherOneToMany":92,"./HttpGetEndpoint":93,"./HttpPostEndpoint":94,"./Mixer":95,"./PlayerEndpoint":96,"./RecorderEndpoint":97,"./RtpEndpoint":98,"./WebRtcEndpoint":99,"./abstracts":101,"./complexTypes":105}],107:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Filter = require('kurento-client-core').abstracts.Filter;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * FaceOverlayFilter interface. This type of {@link module:core/abstracts.Filter
 *
 * @classdesc
 *  FaceOverlayFilter interface. This type of {@link
 *  module:core/abstracts.Filter Filter} detects faces in a video feed. The face
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.FaceOverlayFilter
 */
function FaceOverlayFilter(){
  FaceOverlayFilter.super_.call(this);
};
inherits(FaceOverlayFilter, Filter);


//
// Public methods
//


/**
 * Sets the image to use as overlay on the detected faces.
 *
 * @alias module:filters.FaceOverlayFilter.setOverlayedImage
 *
 * @param {external:String} uri
 *  URI where the image is located
 *
 * @param {external:Number} offsetXPercent
 *  the offset applied to the image, from the X coordinate of the detected face
 *  upper right corner. A positive value indicates right displacement, while a
 *  negative value moves the overlaid image to the left. This offset is
 *  specified as a percentage of the face width.
 *  For example, to cover the detected face with the overlaid image, the
 *  parameter has to be <code>0.0</code>. Values of <code>1.0</code> or
 *  <code>-1.0</code> indicate that the image upper right corner will be at the
 *  face´s X coord, +- the face´s width.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} offsetYPercent
 *  the offset applied to the image, from the Y coordinate of the detected face
 *  upper right corner. A positive value indicates up displacement, while a
 *  negative value moves the overlaid image down. This offset is specified as a
 *  percentage of the face width.
 *  For example, to cover the detected face with the overlaid image, the
 *  parameter has to be <code>0.0</code>. Values of <code>1.0</code> or
 *  <code>-1.0</code> indicate that the image upper right corner will be at the
 *  face´s Y coord, +- the face´s width.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} widthPercent
 *  proportional width of the overlaid image, relative to the width of the
 *  detected face. A value of 1.0 implies that the overlaid image will have the
 *  same width as the detected face. Values greater than 1.0 are allowed, while
 *  negative values are forbidden.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} heightPercent
 *  proportional height of the overlaid image, relative to the height of the
 *  detected face. A value of 1.0 implies that the overlaid image will have the
 *  same height as the detected face. Values greater than 1.0 are allowed, while
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {module:filters.FaceOverlayFilter~setOverlayedImageCallback} [callback]
 *
 * @return {external:Promise}
 */
FaceOverlayFilter.prototype.setOverlayedImage = function(uri, offsetXPercent, offsetYPercent, widthPercent, heightPercent, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'uri', uri, {required: true});
  checkType('float', 'offsetXPercent', offsetXPercent, {required: true});
  checkType('float', 'offsetYPercent', offsetYPercent, {required: true});
  checkType('float', 'widthPercent', widthPercent, {required: true});
  checkType('float', 'heightPercent', heightPercent, {required: true});

  var params = {
    uri: uri,
    offsetXPercent: offsetXPercent,
    offsetYPercent: offsetYPercent,
    widthPercent: widthPercent,
    heightPercent: heightPercent,
  };

  return this._invoke(transaction, 'setOverlayedImage', params, callback);
};
/**
 * @callback module:filters.FaceOverlayFilter~setOverlayedImageCallback
 * @param {external:Error} error
 */

/**
 * Clear the image to be shown over each detected face. Stops overlaying the
 * faces.
 *
 * @alias module:filters.FaceOverlayFilter.unsetOverlayedImage
 *
 * @param {module:filters.FaceOverlayFilter~unsetOverlayedImageCallback} [callback]
 *
 * @return {external:Promise}
 */
FaceOverlayFilter.prototype.unsetOverlayedImage = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  if(!arguments.length) callback = undefined;

  return this._invoke(transaction, 'unsetOverlayedImage', callback);
};
/**
 * @callback module:filters.FaceOverlayFilter~unsetOverlayedImageCallback
 * @param {external:Error} error
 */


/**
 * @alias module:filters.FaceOverlayFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  pipeline to which this {@link module:core/abstracts.Filter Filter} belons
 */
FaceOverlayFilter.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:filters.FaceOverlayFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
FaceOverlayFilter.events = Filter.events;


/**
 * Checker for {@link filters.FaceOverlayFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.FaceOverlayFilter} value
 */
function checkFaceOverlayFilter(key, value)
{
  if(!(value instanceof FaceOverlayFilter))
    throw ChecktypeError(key, FaceOverlayFilter, value);
};


module.exports = FaceOverlayFilter;

FaceOverlayFilter.check = checkFaceOverlayFilter;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],108:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Filter = require('kurento-client-core').abstracts.Filter;


/**
 * Create a {@link module:filters.GStreamerFilter GStreamerFilter}
 *
 * @classdesc
 *  This is a generic filter interface, that creates GStreamer filters in the
 *  media server.
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.GStreamerFilter
 */
function GStreamerFilter(){
  GStreamerFilter.super_.call(this);
};
inherits(GStreamerFilter, Filter);


/**
 * @alias module:filters.GStreamerFilter.constructorParams
 *
 * @property {external:String} command
 *  command that would be used to instantiate the filter, as in `gst-launch
 *  <http://rpm.pbone.net/index.php3/stat/45/idpl/19531544/numer/1/nazwa/gst-launch-1.0>`__
 *
 * @property {external:FilterType} [filterType]
 *  Filter type that define if the filter is set as audio, video or autodetect
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the filter
 *  belongs
 */
GStreamerFilter.constructorParams = {
  command: {
    type: 'String',
    required: true
  },

  filterType: {
    type: 'FilterType',
  },

  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:filters.GStreamerFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
GStreamerFilter.events = Filter.events;


/**
 * Checker for {@link filters.GStreamerFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.GStreamerFilter} value
 */
function checkGStreamerFilter(key, value)
{
  if(!(value instanceof GStreamerFilter))
    throw ChecktypeError(key, GStreamerFilter, value);
};


module.exports = GStreamerFilter;

GStreamerFilter.check = checkGStreamerFilter;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],109:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Filter = require('kurento-client-core').abstracts.Filter;


function noop(error) {
  if (error) console.trace(error);
};


/**
 * ImageOverlayFilter interface. This type of {@link
 * module:core/abstracts.Filter Filter} draws an image in a configured position
 * over a video feed.
 *
 * @classdesc
 *  ImageOverlayFilter interface. This type of {@link
 *  module:core/abstracts.Filter Filter} draws an image in a configured position
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.ImageOverlayFilter
 */
function ImageOverlayFilter(){
  ImageOverlayFilter.super_.call(this);
};
inherits(ImageOverlayFilter, Filter);


//
// Public methods
//


/**
 * Add an image to be used as overlay.
 *
 * @alias module:filters.ImageOverlayFilter.addImage
 *
 * @param {external:String} id
 *  image ID
 *
 * @param {external:String} uri
 *  URI where the image is located
 *
 * @param {external:Number} offsetXPercent
 *  Percentage relative to the image width to calculate the X coordinate of the
 *  position [0..1]
 *
 * @param {external:Number} offsetYPercent
 *  Percentage relative to the image height to calculate the Y coordinate of the
 *
 * @param {external:Number} widthPercent
 *  Proportional width of the overlaid image, relative to the width of the video
 *
 * @param {external:Number} heightPercent
 *  Proportional height of the overlaid image, relative to the height of the
 *  video [0..1].
 *
 * @param {module:filters.ImageOverlayFilter~addImageCallback} [callback]
 *
 * @return {external:Promise}
 */
ImageOverlayFilter.prototype.addImage = function(id, uri, offsetXPercent, offsetYPercent, widthPercent, heightPercent, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'id', id, {required: true});
  checkType('String', 'uri', uri, {required: true});
  checkType('float', 'offsetXPercent', offsetXPercent, {required: true});
  checkType('float', 'offsetYPercent', offsetYPercent, {required: true});
  checkType('float', 'widthPercent', widthPercent, {required: true});
  checkType('float', 'heightPercent', heightPercent, {required: true});

  var params = {
    id: id,
    uri: uri,
    offsetXPercent: offsetXPercent,
    offsetYPercent: offsetYPercent,
    widthPercent: widthPercent,
    heightPercent: heightPercent,
  };

  return this._invoke(transaction, 'addImage', params, callback);
};
/**
 * @callback module:filters.ImageOverlayFilter~addImageCallback
 * @param {external:Error} error
 */

/**
 * Remove the image with the given ID.
 *
 * @alias module:filters.ImageOverlayFilter.removeImage
 *
 * @param {external:String} id
 *  Image ID to be removed
 *
 * @param {module:filters.ImageOverlayFilter~removeImageCallback} [callback]
 *
 * @return {external:Promise}
 */
ImageOverlayFilter.prototype.removeImage = function(id, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'id', id, {required: true});

  var params = {
    id: id,
  };

  return this._invoke(transaction, 'removeImage', params, callback);
};
/**
 * @callback module:filters.ImageOverlayFilter~removeImageCallback
 * @param {external:Error} error
 */


/**
 * @alias module:filters.ImageOverlayFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  pipeline to which this {@link module:core/abstracts.Filter Filter} belons
 */
ImageOverlayFilter.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:filters.ImageOverlayFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
ImageOverlayFilter.events = Filter.events;


/**
 * Checker for {@link filters.ImageOverlayFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.ImageOverlayFilter} value
 */
function checkImageOverlayFilter(key, value)
{
  if(!(value instanceof ImageOverlayFilter))
    throw ChecktypeError(key, ImageOverlayFilter, value);
};


module.exports = ImageOverlayFilter;

ImageOverlayFilter.check = checkImageOverlayFilter;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],110:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Filter = require('kurento-client-core').abstracts.Filter;


/**
 * Builder for the {@link module:filters.ZBarFilter ZBarFilter}.
 *
 * @classdesc
 *  This filter detects <a
 *  href="http://www.kurento.org/docs/current/glossary.html#term-qr">QR</a>
 *  codes in a video feed. When a code is found, the filter raises a
 *  :rom:evnt:`CodeFound` event.
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.ZBarFilter
 *
 * @fires {@link module:filters#event:CodeFound CodeFound}
 */
function ZBarFilter(){
  ZBarFilter.super_.call(this);
};
inherits(ZBarFilter, Filter);


/**
 * @alias module:filters.ZBarFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the filter
 *  belongs
 */
ZBarFilter.constructorParams = {
  mediaPipeline: {
    type: 'MediaPipeline',
    required: true
  },
};

/**
 * @alias module:filters.ZBarFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
ZBarFilter.events = Filter.events.concat(['CodeFound']);


/**
 * Checker for {@link filters.ZBarFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.ZBarFilter} value
 */
function checkZBarFilter(key, value)
{
  if(!(value instanceof ZBarFilter))
    throw ChecktypeError(key, ZBarFilter, value);
};


module.exports = ZBarFilter;

ZBarFilter.check = checkZBarFilter;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],111:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Filter = require('kurento-client-core').abstracts.Filter;


/**
 * @classdesc
 *  Generic OpenCV Filter
 *
 * @abstract
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters/abstracts.OpenCVFilter
 */
function OpenCVFilter(){
  OpenCVFilter.super_.call(this);
};
inherits(OpenCVFilter, Filter);


/**
 * @alias module:filters/abstracts.OpenCVFilter.constructorParams
 */
OpenCVFilter.constructorParams = {};

/**
 * @alias module:filters/abstracts.OpenCVFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
OpenCVFilter.events = Filter.events;


/**
 * Checker for {@link filters/abstracts.OpenCVFilter}
 *
 * @memberof module:filters/abstracts
 *
 * @param {external:String} key
 * @param {module:filters/abstracts.OpenCVFilter} value
 */
function checkOpenCVFilter(key, value)
{
  if(!(value instanceof OpenCVFilter))
    throw ChecktypeError(key, OpenCVFilter, value);
};


module.exports = OpenCVFilter;

OpenCVFilter.check = checkOpenCVFilter;

},{"inherits":40,"kurento-client":"kurento-client","kurento-client-core":88}],112:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module filters/abstracts
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

var OpenCVFilter = require('./OpenCVFilter');


exports.OpenCVFilter = OpenCVFilter;

},{"./OpenCVFilter":111}],113:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module filters
 *
 * @copyright 2013-2014 Kurento (http://kurento.org/)
 * @license LGPL
 */

Object.defineProperty(exports, 'name',    {value: 'filters'});
Object.defineProperty(exports, 'version', {value: '6.0.0-dev'});


var FaceOverlayFilter = require('./FaceOverlayFilter');
var GStreamerFilter = require('./GStreamerFilter');
var ImageOverlayFilter = require('./ImageOverlayFilter');
var ZBarFilter = require('./ZBarFilter');


exports.FaceOverlayFilter = FaceOverlayFilter;
exports.GStreamerFilter = GStreamerFilter;
exports.ImageOverlayFilter = ImageOverlayFilter;
exports.ZBarFilter = ZBarFilter;

exports.abstracts = require('./abstracts');

},{"./FaceOverlayFilter":107,"./GStreamerFilter":108,"./ImageOverlayFilter":109,"./ZBarFilter":110,"./abstracts":112}],114:[function(require,module,exports){
function Mapper()
{
  var sources = {};


  this.forEach = function(callback)
  {
    for(var key in sources)
    {
      var source = sources[key];

      for(var key2 in source)
        callback(source[key2]);
    };
  };

  this.get = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return undefined;

    return ids[id];
  };

  this.remove = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return;

    delete ids[id];

    if(!Object.keys(ids).length)
      delete sources[source];
  };

  this.set = function(value, id, source)
  {
    if(value == undefined)
      return this.remove(id, source);

    var ids = sources[source];
    if(ids == undefined)
      sources[source] = ids = {};

    ids[id] = value;
  };
};


Mapper.prototype.pop = function(id, source)
{
  var value = this.get(id, source);
  if(value == undefined)
    return undefined;

  this.remove(id, source);

  return value;
};


module.exports = Mapper;

},{}],115:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var JsonRpcClient  = require('./jsonrpcclient');


exports.JsonRpcClient  = JsonRpcClient;

},{"./jsonrpcclient":116}],116:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var RpcBuilder = require('../..');

var WebSocket = require('ws');


function JsonRpcClient(wsUrl, onRequest, onerror)
{
  var ws = new WebSocket(wsUrl);
      ws.addEventListener('error', onerror);

  var rpc = new RpcBuilder(RpcBuilder.packers.JsonRPC, ws, onRequest);

  this.close       = rpc.close.bind(rpc);
  this.sendRequest = rpc.encode.bind(rpc);
};


module.exports  = JsonRpcClient;

},{"../..":117,"ws":121}],117:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var EventEmitter = require('events').EventEmitter;

var inherits = require('inherits');

var packers = require('./packers');
var Mapper = require('./Mapper');


const BASE_TIMEOUT = 5000;


function unifyResponseMethods(responseMethods)
{
  if(!responseMethods) return {};

  for(var key in responseMethods)
  {
    var value = responseMethods[key];

    if(typeof value == 'string')
      responseMethods[key] =
      {
        response: value
      }
  };

  return responseMethods;
};

function unifyTransport(transport)
{
  if(!transport) return;

  // Transport as a function
  if(transport instanceof Function)
    return {send: transport};

  // WebSocket & DataChannel
  if(transport.send instanceof Function)
    return transport;

  // Message API (Inter-window & WebWorker)
  if(transport.postMessage instanceof Function)
  {
    transport.send = transport.postMessage;
    return transport;
  }

  // Stream API
  if(transport.write instanceof Function)
  {
    transport.send = transport.write;
    return transport;
  }

  // Transports that only can receive messages, but not send
  if(transport.onmessage !== undefined) return;
  if(transport.pause instanceof Function) return;

  throw new SyntaxError("Transport is not a function nor a valid object");
};


/**
 * Representation of a RPC notification
 *
 * @class
 *
 * @constructor
 *
 * @param {String} method -method of the notification
 * @param params - parameters of the notification
 */
function RpcNotification(method, params)
{
  Object.defineProperty(this, 'method', {value: method, enumerable: true});
  Object.defineProperty(this, 'params', {value: params, enumerable: true});
};


/**
 * @class
 *
 * @constructor
 *
 * @param {object} packer
 *
 * @param {object} [options]
 *
 * @param {object} [transport]
 *
 * @param {Function} [onRequest]
 */
function RpcBuilder(packer, options, transport, onRequest)
{
  var self = this;

  if(!packer)
    throw new SyntaxError('Packer is not defined');

  if(!packer.pack || !packer.unpack)
    throw new SyntaxError('Packer is invalid');

  var responseMethods = unifyResponseMethods(packer.responseMethods);


  if(options instanceof Function)
  {
    if(transport != undefined)
      throw new SyntaxError("There can't be parameters after onRequest");

    onRequest = options;
    transport = undefined;
    options   = undefined;
  };

  if(options && options.send instanceof Function)
  {
    if(transport && !(transport instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

    onRequest = transport;
    transport = options;
    options   = undefined;
  };

  if(transport instanceof Function)
  {
    if(onRequest != undefined)
      throw new SyntaxError("There can't be parameters after onRequest");

    onRequest = transport;
    transport = undefined;
  };

  if(transport && transport.send instanceof Function)
    if(onRequest && !(onRequest instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

  options = options || {};


  EventEmitter.call(this);

  if(onRequest)
    this.on('request', onRequest);


  Object.defineProperty(this, 'peerID', {value: options.peerID});

  var max_retries = options.max_retries || 0;


  function transportMessage(event)
  {
    self.decode(event.data || event);
  };

  Object.defineProperty(this, 'transport',
  {
    get: function()
    {
      return transport;
    },

    set: function(value)
    {
      // Remove listener from old transport
      if(transport)
      {
        // W3C transports
        if(transport.removeEventListener)
          transport.removeEventListener('message', transportMessage);

        // Node.js Streams API
        else if(transport.removeListener)
          transport.removeListener('data', transportMessage);
      };

      // Set listener on new transport
      if(value)
      {
        // W3C transports
        if(value.addEventListener)
          value.addEventListener('message', transportMessage);

        // Node.js Streams API
        else if(value.addListener)
          value.addListener('data', transportMessage);
      };

      transport = unifyTransport(value);
    }
  })

  this.transport = transport;


  const request_timeout    = options.request_timeout    || BASE_TIMEOUT;
  const response_timeout   = options.response_timeout   || BASE_TIMEOUT;
  const duplicates_timeout = options.duplicates_timeout || BASE_TIMEOUT;


  var requestID = 0;

  var requests  = new Mapper();
  var responses = new Mapper();
  var processedResponses = new Mapper();

  var message2Key = {};


  /**
   * Store the response to prevent to process duplicate request later
   */
  function storeResponse(message, id, dest)
  {
    var response =
    {
      message: message,
      /** Timeout to auto-clean old responses */
      timeout: setTimeout(function()
      {
        responses.remove(id, dest);
      },
      response_timeout)
    };

    responses.set(response, id, dest);
  };

  /**
   * Store the response to ignore duplicated messages later
   */
  function storeProcessedResponse(ack, from)
  {
    var timeout = setTimeout(function()
    {
      processedResponses.remove(ack, from);
    },
    duplicates_timeout);

    processedResponses.set(timeout, ack, from);
  };


  /**
   * Representation of a RPC request
   *
   * @class
   * @extends RpcNotification
   *
   * @constructor
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param {Integer} id - identifier of the request
   * @param [from] - source of the notification
   */
  function RpcRequest(method, params, id, from, transport)
  {
    RpcNotification.call(this, method, params);

    Object.defineProperty(this, 'transport',
    {
      get: function()
      {
        return transport;
      },

      set: function(value)
      {
        transport = unifyTransport(value);
      }
    })

    var response = responses.get(id, from);

    /**
     * @constant {Boolean} duplicated
     */
    if(!(transport || self.transport))
      Object.defineProperty(this, 'duplicated',
      {
        value: Boolean(response)
      });

    var responseMethod = responseMethods[method];

    this.pack = packer.pack.bind(packer, this, id)

    /**
     * Generate a response to this request
     *
     * @param {Error} [error]
     * @param {*} [result]
     *
     * @returns {string}
     */
    this.reply = function(error, result, transport)
    {
      // Fix optional parameters
      if(error instanceof Function || error && error.send instanceof Function)
      {
        if(result != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = error;
        result = null;
        error = undefined;
      }

      else if(result instanceof Function
      || result && result.send instanceof Function)
      {
        if(transport != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = result;
        result = null;
      };

      transport = unifyTransport(transport);

      // Duplicated request, remove old response timeout
      if(response)
        clearTimeout(response.timeout);

      if(from != undefined)
      {
        if(error)
          error.dest = from;

        if(result)
          result.dest = from;
      };

      var message;

      // New request or overriden one, create new response with provided data
      if(error || result != undefined)
      {
        if(self.peerID != undefined)
        {
          if(error)
            error.from = self.peerID;
          else
            result.from = self.peerID;
        }

        // Protocol indicates that responses has own request methods
        if(responseMethod)
        {
          if(responseMethod.error == undefined && error)
            message =
            {
              error: error
            };

          else
          {
            var method = error
                       ? responseMethod.error
                       : responseMethod.response;

            message =
            {
              method: method,
              params: error || result
            };
          }
        }
        else
          message =
          {
            error:  error,
            result: result
          };

        message = packer.pack(message, id);
      }

      // Duplicate & not-overriden request, re-send old response
      else if(response)
        message = response.message;

      // New empty reply, response null value
      else
        message = packer.pack({result: null}, id);

      // Store the response to prevent to process a duplicated request later
      storeResponse(message, id, from);

      // Return the stored response so it can be directly send back
      transport = transport || this.transport || self.transport;

      if(transport)
        return transport.send(message);

      return message;
    }
  };
  inherits(RpcRequest, RpcNotification);


  function cancel(message)
  {
    var key = message2Key[message];
    if(!key) return;

    delete message2Key[message];

    var request = requests.pop(key.id, key.dest);
    if(!request) return;

    clearTimeout(request.timeout);

    // Start duplicated responses timeout
    storeProcessedResponse(key.id, key.dest);
  };

  /**
   * Allow to cancel a request and don't wait for a response
   *
   * If `message` is not given, cancel all the request
   */
  this.cancel = function(message)
  {
    if(message) return cancel(message);

    for(var message in message2Key)
      cancel(message);
  };


  this.close = function()
  {
    // Prevent to receive new messages
    var transport = self.transport;
    if(transport && transport.close)
       transport.close();

    // Request & processed responses
    this.cancel();

    processedResponses.forEach(clearTimeout);

    // Responses
    responses.forEach(function(response)
    {
      clearTimeout(response.timeout);
    });
  };


  /**
   * Generates and encode a JsonRPC 2.0 message
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param [dest] - destination of the notification
   * @param {object} [transport] - transport where to send the message
   * @param [callback] - function called when a response to this request is
   *   received. If not defined, a notification will be send instead
   *
   * @returns {string} A raw JsonRPC 2.0 request or notification string
   */
  this.encode = function(method, params, dest, transport, callback)
  {
    // Fix optional parameters
    if(params instanceof Function)
    {
      if(dest != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = params;
      transport = undefined;
      dest      = undefined;
      params    = undefined;
    }

    else if(dest instanceof Function)
    {
      if(transport != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = dest;
      transport = undefined;
      dest      = undefined;
    }

    else if(transport instanceof Function)
    {
      if(callback != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = transport;
      transport = undefined;
    };

    if(self.peerID != undefined)
    {
      params = params || {};

      params.from = self.peerID;
    };

    if(dest != undefined)
    {
      params = params || {};

      params.dest = dest;
    };

    // Encode message
    var message =
    {
      method: method,
      params: params
    };

    if(callback)
    {
      var id = requestID++;
      var retried = 0;

      message = packer.pack(message, id);

      function dispatchCallback(error, result)
      {
        self.cancel(message);

        callback(error, result);
      };

      var request =
      {
        message:         message,
        callback:        dispatchCallback,
        responseMethods: responseMethods[method] || {}
      };

      var encode_transport = unifyTransport(transport);

      function sendRequest(transport)
      {
        request.timeout = setTimeout(timeout,
                                     request_timeout*Math.pow(2, retried++));
        message2Key[message] = {id: id, dest: dest};
        requests.set(request, id, dest);

        transport = transport || encode_transport || self.transport;
        if(transport)
          return transport.send(message);

        return message;
      };

      function retry(transport)
      {
        transport = unifyTransport(transport);

        console.warn(retried+' retry for request message:',message);

        var timeout = processedResponses.pop(id, dest);
        clearTimeout(timeout);

        return sendRequest(transport);
      };

      function timeout()
      {
        if(retried < max_retries)
          return retry(transport);

        var error = new Error('Request has timed out');
            error.request = message;

        error.retry = retry;

        dispatchCallback(error)
      };

      return sendRequest(transport);
    };

    // Return the packed message
    message = packer.pack(message);

    transport = transport || self.transport;
    if(transport)
      return transport.send(message);

    return message;
  };

  /**
   * Decode and process a JsonRPC 2.0 message
   *
   * @param {string} message - string with the content of the message
   *
   * @returns {RpcNotification|RpcRequest|undefined} - the representation of the
   *   notification or the request. If a response was processed, it will return
   *   `undefined` to notify that it was processed
   *
   * @throws {TypeError} - Message is not defined
   */
  this.decode = function(message, transport)
  {
    if(!message)
      throw new TypeError("Message is not defined");

    try
    {
      message = packer.unpack(message);
    }
    catch(e)
    {
      // Ignore invalid messages
      return console.debug(e, message);
    };

    var id     = message.id;
    var ack    = message.ack;
    var method = message.method;
    var params = message.params || {};

    var from = params.from;
    var dest = params.dest;

    // Ignore messages send by us
    if(self.peerID != undefined && from == self.peerID) return;

    // Notification
    if(id == undefined && ack == undefined)
    {
      var notification = new RpcNotification(method, params);

      if(self.emit('request', notification)) return;
      return notification;
    };


    function processRequest()
    {
      // If we have a transport and it's a duplicated request, reply inmediatly
      transport = unifyTransport(transport) || self.transport;
      if(transport)
      {
        var response = responses.get(id, from);
        if(response)
          return transport.send(response.message);
      };

      var idAck = (id != undefined) ? id : ack;
      var request = new RpcRequest(method, params, idAck, from, transport);

      if(self.emit('request', request)) return;
      return request;
    };

    function processResponse(request, error, result)
    {
      request.callback(error, result);
    };

    function duplicatedResponse(timeout)
    {
      console.warn("Response already processed", message);

      // Update duplicated responses timeout
      clearTimeout(timeout);
      storeProcessedResponse(ack, from);
    };


    // Request, or response with own method
    if(method)
    {
      // Check if it's a response with own method
      if(dest == undefined || dest == self.peerID)
      {
        var request = requests.get(ack, from);
        if(request)
        {
          var responseMethods = request.responseMethods;

          if(method == responseMethods.error)
            return processResponse(request, params);

          if(method == responseMethods.response)
            return processResponse(request, null, params);

          return processRequest();
        }

        var processed = processedResponses.get(ack, from);
        if(processed)
          return duplicatedResponse(processed);
      }

      // Request
      return processRequest();
    };

    var error  = message.error;
    var result = message.result;

    // Ignore responses not send to us
    if(error  && error.dest  && error.dest  != self.peerID) return;
    if(result && result.dest && result.dest != self.peerID) return;

    // Response
    var request = requests.get(ack, from);
    if(!request)
    {
      var processed = processedResponses.get(ack, from);
      if(processed)
        return duplicatedResponse(processed);

      return console.warn("No callback was defined for this message", message);
    };

    // Process response
    processResponse(request, error, result);
  };
};
inherits(RpcBuilder, EventEmitter);


RpcBuilder.RpcNotification = RpcNotification;


module.exports = RpcBuilder;

var clients = require('./clients');

RpcBuilder.clients = clients;
RpcBuilder.packers = packers;

},{"./Mapper":114,"./clients":115,"./packers":120,"events":17,"inherits":40}],118:[function(require,module,exports){
/**
 * JsonRPC 2.0 packer
 */

/**
 * Pack a JsonRPC 2.0 message
 *
 * @param {Object} message - object to be packaged. It requires to have all the
 *   fields needed by the JsonRPC 2.0 message that it's going to be generated
 *
 * @return {String} - the stringified JsonRPC 2.0 message
 */
function pack(message, id)
{
  var result =
  {
    jsonrpc: "2.0"
  };

  // Request
  if(message.method)
  {
    result.method = message.method;

    if(message.params)
      result.params = message.params;

    // Request is a notification
    if(id != undefined)
      result.id = id;
  }

  // Response
  else if(id != undefined)
  {
    if(message.error)
    {
      if(message.result !== undefined)
        throw new TypeError("Both result and error are defined");

      result.error = message.error;
    }
    else if(message.result !== undefined)
      result.result = message.result;
    else
      throw new TypeError("No result or error is defined");

    result.id = id;
  };

  return JSON.stringify(result);
};

/**
 * Unpack a JsonRPC 2.0 message
 *
 * @param {String} message - string with the content of the JsonRPC 2.0 message
 *
 * @throws {TypeError} - Invalid JsonRPC version
 *
 * @return {Object} - object filled with the JsonRPC 2.0 message content
 */
function unpack(message)
{
  var result = message;

  if(typeof message == 'string' || message instanceof String)
    result = JSON.parse(message);

  // Check if it's a valid message

  var version = result.jsonrpc;
  if(version != "2.0")
    throw new TypeError("Invalid JsonRPC version '"+version+"': "+message);

  // Response
  if(result.method == undefined)
  {
    if(result.id == undefined)
      throw new TypeError("Invalid message: "+message);

    var result_defined = result.result !== undefined;
    var error_defined  = result.error  !== undefined;

    // Check only result or error is defined, not both or none
    if(result_defined && error_defined)
      throw new TypeError("Both result and error are defined: "+message);

    if(!result_defined && !error_defined)
      throw new TypeError("No result or error is defined: "+message);

    result.ack = result.id;
    delete result.id;
  }

  // Return unpacked message
  return result;
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],119:[function(require,module,exports){
function pack(message)
{
  throw new TypeError("Not yet implemented");
};

function unpack(message)
{
  throw new TypeError("Not yet implemented");
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],120:[function(require,module,exports){
var JsonRPC = require('./JsonRPC');
var XmlRPC  = require('./XmlRPC');


exports.JsonRPC = JsonRPC;
exports.XmlRPC  = XmlRPC;

},{"./JsonRPC":118,"./XmlRPC":119}],121:[function(require,module,exports){

/**
 * Module dependencies.
 */

var global = (function() { return this; })();

/**
 * WebSocket constructor.
 */

var WebSocket = global.WebSocket || global.MozWebSocket;

/**
 * Module exports.
 */

module.exports = WebSocket ? ws : null;

/**
 * WebSocket constructor.
 *
 * The third `opts` options object gets ignored in web browsers, since it's
 * non-standard, and throws a TypeError if passed to the constructor.
 * See: https://github.com/einaros/ws/issues/227
 *
 * @param {String} uri
 * @param {Array} protocols (optional)
 * @param {Object) opts (optional)
 * @api public
 */

function ws(uri, protocols, opts) {
  var instance;
  if (protocols) {
    instance = new WebSocket(uri, protocols);
  } else {
    instance = new WebSocket(uri);
  }
  return instance;
}

if (WebSocket) ws.prototype = WebSocket.prototype;

},{}],122:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


/**
 * Define a callback as the continuation of a promise
 */
function promiseCallback(promise, callback, thisArg)
{
  if(callback)
  {
    function callback2(error, result)
    {
      try
      {
        callback.call(thisArg, error, result);
      }
      catch(exception)
      {
        // Show the exception in the console with its full stack trace
        console.error(exception);
        throw exception;
      }
    };

    promise = promise.then(callback2.bind(undefined, null), callback2);
  };

  return promise
};


module.exports = promiseCallback;

},{}],123:[function(require,module,exports){
var websocket = require('websocket-stream');
var inject = require('reconnect-core');

module.exports = inject(function () {
  // Create new websocket-stream instance
  var args = [].slice.call(arguments);
  var ws = websocket.apply(null, args);

  // Copy buffer from old websocket-stream instance on the new one
  var prevCon = this.prevCon;
  if(prevCon && prevCon._buffer)
    ws._buffer = prevCon._buffer;
  this.prevCon = ws;

  // Return new websocket-stream instance
  return ws;
});

},{"reconnect-core":124,"websocket-stream":131}],124:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter
var backoff = require('backoff')

module.exports =
function (createConnection) {
  return function (opts, onConnect) {
    onConnect = 'function' == typeof opts ? opts : onConnect
    opts = 'object' == typeof opts ? opts : {initialDelay: 1e3, maxDelay: 30e3}
    if(!onConnect)
      onConnect = opts.onConnect

    var emitter = new EventEmitter()
    emitter.connected = false
    emitter.reconnect = true

    if(onConnect)
      //use "connection" to match core (net) api.
      emitter.on('connection', onConnect)

    var backoffMethod = (backoff[opts.type] || backoff.fibonacci) (opts)

    if(opts.failAfter)
      backoffMethod.failAfter(opts.failAfter);

    backoffMethod.on('backoff', function (n, d, e) {
      emitter.emit('backoff', n, d, e)
    })
    backoffMethod.on('fail', function (e) {
      emitter.disconnect()
      emitter.emit('fail', e)
    })

    var args
    function attempt (n, delay) {
      if(emitter.connected) return
      if(!emitter.reconnect) return

      emitter.emit('reconnect', n, delay)
      var con = createConnection.apply(emitter, args)
      emitter._connection = con

      function onError (err) {
        con.removeListener('error', onError)
        emitter.emit('error', err)
        onDisconnect(err)
      }

      function onDisconnect (err) {
        emitter.connected = false
        con.removeListener('close', onDisconnect)
        con.removeListener('end'  , onDisconnect)

        //hack to make http not crash.
        //HTTP IS THE WORST PROTOCOL.
        if(con.constructor.name == 'Request')
          con.on('error', function () {})

        //emit disconnect before checking reconnect, so user has a chance to decide not to.
        emitter.emit('disconnect', err)

        if(!emitter.reconnect) return
        try { backoffMethod.backoff() } catch (_) { }
      }

      con
        .on('error', onError)
        .on('close', onDisconnect)
        .on('end'  , onDisconnect)

      if(opts.immediate || con.constructor.name == 'Request') {
        emitter.connected = true
        emitter.emit('connect', con)
        emitter.emit('connection', con)
        con.once('data', function () {
          //this is the only way to know for sure that data is coming...
          backoffMethod.reset()
        })
      } else {
        con
          .once('connect', function () {
            backoffMethod.reset()
            emitter.connected = true
            if(onConnect)
              con.removeListener('connect', onConnect)
            emitter.emit('connect', con)
            //also support net style 'connection' method.
            emitter.emit('connection', con)
          })
      }
    }

    emitter.connect =
    emitter.listen = function () {
      this.reconnect = true
      if(emitter.connected) return
      backoffMethod.reset()
      backoffMethod.on('ready', attempt)
      args = args || [].slice.call(arguments)
      attempt(0, 0)
      return emitter
    }

    //force reconnection

    emitter.disconnect = function () {
      this.reconnect = false

      if(emitter._connection)
        emitter._connection.end()

      return emitter
    }

    return emitter
  }

}

},{"backoff":125,"events":17}],125:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var Backoff = require('./lib/backoff');
var ExponentialBackoffStrategy = require('./lib/strategy/exponential');
var FibonacciBackoffStrategy = require('./lib/strategy/fibonacci');
var FunctionCall = require('./lib/function_call.js');

module.exports.Backoff = Backoff;
module.exports.FunctionCall = FunctionCall;
module.exports.FibonacciStrategy = FibonacciBackoffStrategy;
module.exports.ExponentialStrategy = ExponentialBackoffStrategy;

/**
 * Constructs a Fibonacci backoff.
 * @param options Fibonacci backoff strategy arguments.
 * @return The fibonacci backoff.
 * @see FibonacciBackoffStrategy
 */
module.exports.fibonacci = function(options) {
    return new Backoff(new FibonacciBackoffStrategy(options));
};

/**
 * Constructs an exponential backoff.
 * @param options Exponential strategy arguments.
 * @return The exponential backoff.
 * @see ExponentialBackoffStrategy
 */
module.exports.exponential = function(options) {
    return new Backoff(new ExponentialBackoffStrategy(options));
};

/**
 * Constructs a FunctionCall for the given function and arguments.
 * @param fn The function to wrap in a backoff handler.
 * @param vargs The function's arguments (var args).
 * @param callback The function's callback.
 * @return The FunctionCall instance.
 */
module.exports.call = function(fn, vargs, callback) {
    var args = Array.prototype.slice.call(arguments);
    fn = args[0];
    vargs = args.slice(1, args.length - 1);
    callback = args[args.length - 1];
    return new FunctionCall(fn, vargs, callback);
};

},{"./lib/backoff":126,"./lib/function_call.js":127,"./lib/strategy/exponential":128,"./lib/strategy/fibonacci":129}],126:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

/**
 * Backoff driver.
 * @param backoffStrategy Backoff delay generator/strategy.
 * @constructor
 */
function Backoff(backoffStrategy) {
    events.EventEmitter.call(this);

    this.backoffStrategy_ = backoffStrategy;
    this.maxNumberOfRetry_ = -1;
    this.backoffNumber_ = 0;
    this.backoffDelay_ = 0;
    this.timeoutID_ = -1;

    this.handlers = {
        backoff: this.onBackoff_.bind(this)
    };
}
util.inherits(Backoff, events.EventEmitter);

/**
 * Sets a limit, greater than 0, on the maximum number of backoffs. A 'fail'
 * event will be emitted when the limit is reached.
 * @param maxNumberOfRetry The maximum number of backoffs.
 */
Backoff.prototype.failAfter = function(maxNumberOfRetry) {
    if (maxNumberOfRetry < 1) {
        throw new Error('Maximum number of retry must be greater than 0. ' +
                        'Actual: ' + maxNumberOfRetry);
    }

    this.maxNumberOfRetry_ = maxNumberOfRetry;
};

/**
 * Starts a backoff operation.
 * @param err Optional paramater to let the listeners know why the backoff
 *     operation was started.
 */
Backoff.prototype.backoff = function(err) {
    if (this.timeoutID_ !== -1) {
        throw new Error('Backoff in progress.');
    }

    if (this.backoffNumber_ === this.maxNumberOfRetry_) {
        this.emit('fail', err);
        this.reset();
    } else {
        this.backoffDelay_ = this.backoffStrategy_.next();
        this.timeoutID_ = setTimeout(this.handlers.backoff, this.backoffDelay_);
        this.emit('backoff', this.backoffNumber_, this.backoffDelay_, err);
    }
};

/**
 * Handles the backoff timeout completion.
 * @private
 */
Backoff.prototype.onBackoff_ = function() {
    this.timeoutID_ = -1;
    this.emit('ready', this.backoffNumber_, this.backoffDelay_);
    this.backoffNumber_++;
};

/**
 * Stops any backoff operation and resets the backoff delay to its inital
 * value.
 */
Backoff.prototype.reset = function() {
    this.backoffNumber_ = 0;
    this.backoffStrategy_.reset();
    clearTimeout(this.timeoutID_);
    this.timeoutID_ = -1;
};

module.exports = Backoff;

},{"events":17,"util":39}],127:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

var Backoff = require('./backoff');
var FibonacciBackoffStrategy = require('./strategy/fibonacci');

/**
 * Returns true if the specified value is a function
 * @param val Variable to test.
 * @return Whether variable is a function.
 */
function isFunction(val) {
    return typeof val == 'function';
}

/**
 * Manages the calling of a function in a backoff loop.
 * @param fn Function to wrap in a backoff handler.
 * @param args Array of function's arguments.
 * @param callback Function's callback.
 * @constructor
 */
function FunctionCall(fn, args, callback) {
    events.EventEmitter.call(this);

    if (!isFunction(fn)) {
        throw new Error('fn should be a function.' +
                        'Actual: ' + typeof fn);
    }

    if (!isFunction(callback)) {
        throw new Error('callback should be a function.' +
                        'Actual: ' + typeof fn);
    }

    this.function_ = fn;
    this.arguments_ = args;
    this.callback_ = callback;
    this.results_ = [];

    this.backoff_ = null;
    this.strategy_ = null;
    this.failAfter_ = -1;

    this.state_ = FunctionCall.State_.PENDING;
}
util.inherits(FunctionCall, events.EventEmitter);

/**
 * Enum of states in which the FunctionCall can be.
 * @private
 */
FunctionCall.State_ = {
    PENDING: 0,
    RUNNING: 1,
    COMPLETED: 2,
    ABORTED: 3
};

/**
 * @return Whether the call is pending.
 */
FunctionCall.prototype.isPending = function() {
    return this.state_ == FunctionCall.State_.PENDING;
};

/**
 * @return Whether the call is in progress.
 */
FunctionCall.prototype.isRunning = function() {
    return this.state_ == FunctionCall.State_.RUNNING;
};

/**
 * @return Whether the call is completed.
 */
FunctionCall.prototype.isCompleted = function() {
    return this.state_ == FunctionCall.State_.COMPLETED;
};

/**
 * @return Whether the call is aborted.
 */
FunctionCall.prototype.isAborted = function() {
    return this.state_ == FunctionCall.State_.ABORTED;
};

/**
 * Sets the backoff strategy.
 * @param strategy The backoff strategy to use.
 * @return Itself for chaining.
 */
FunctionCall.prototype.setStrategy = function(strategy) {
    if (!this.isPending()) {
        throw new Error('FunctionCall in progress.');
    }
    this.strategy_ = strategy;
    return this;
};

/**
 * Returns all intermediary results returned by the wrapped function since
 * the initial call.
 * @return An array of intermediary results.
 */
FunctionCall.prototype.getResults = function() {
    return this.results_.concat();
};

/**
 * Sets the backoff limit.
 * @param maxNumberOfRetry The maximum number of backoffs.
 * @return Itself for chaining.
 */
FunctionCall.prototype.failAfter = function(maxNumberOfRetry) {
    if (!this.isPending()) {
        throw new Error('FunctionCall in progress.');
    }
    this.failAfter_ = maxNumberOfRetry;
    return this;
};

/**
 * Aborts the call.
 */
FunctionCall.prototype.abort = function() {
    if (this.isCompleted()) {
        throw new Error('FunctionCall already completed.');
    }

    if (this.isRunning()) {
        this.backoff_.reset();
    }

    this.state_ = FunctionCall.State_.ABORTED;
};

/**
 * Initiates the call to the wrapped function.
 * @param backoffFactory Optional factory function used to create the backoff
 *     instance.
 */
FunctionCall.prototype.start = function(backoffFactory) {
    if (this.isAborted()) {
        throw new Error('FunctionCall aborted.');
    } else if (!this.isPending()) {
        throw new Error('FunctionCall already started.');
    }

    var strategy = this.strategy_ || new FibonacciBackoffStrategy();

    this.backoff_ = backoffFactory ?
        backoffFactory(strategy) :
        new Backoff(strategy);

    this.backoff_.on('ready', this.doCall_.bind(this));
    this.backoff_.on('fail', this.doCallback_.bind(this));
    this.backoff_.on('backoff', this.handleBackoff_.bind(this));

    if (this.failAfter_ > 0) {
        this.backoff_.failAfter(this.failAfter_);
    }

    this.state_ = FunctionCall.State_.RUNNING;
    this.doCall_();
};

/**
 * Calls the wrapped function.
 * @private
 */
FunctionCall.prototype.doCall_ = function() {
    var eventArgs = ['call'].concat(this.arguments_);
    events.EventEmitter.prototype.emit.apply(this, eventArgs);
    var callback = this.handleFunctionCallback_.bind(this);
    this.function_.apply(null, this.arguments_.concat(callback));
};

/**
 * Calls the wrapped function's callback with the last result returned by the
 * wrapped function.
 * @private
 */
FunctionCall.prototype.doCallback_ = function() {
    var args = this.results_[this.results_.length - 1];
    this.callback_.apply(null, args);
};

/**
 * Handles wrapped function's completion. This method acts as a replacement
 * for the original callback function.
 * @private
 */
FunctionCall.prototype.handleFunctionCallback_ = function() {
    if (this.isAborted()) {
        return;
    }

    var args = Array.prototype.slice.call(arguments);
    this.results_.push(args); // Save callback arguments.
    events.EventEmitter.prototype.emit.apply(this, ['callback'].concat(args));

    if (args[0]) {
        this.backoff_.backoff(args[0]);
    } else {
        this.state_ = FunctionCall.State_.COMPLETED;
        this.doCallback_();
    }
};

/**
 * Handles backoff event.
 * @param number Backoff number.
 * @param delay Backoff delay.
 * @param err The error that caused the backoff.
 * @private
 */
FunctionCall.prototype.handleBackoff_ = function(number, delay, err) {
    this.emit('backoff', number, delay, err);
};

module.exports = FunctionCall;

},{"./backoff":126,"./strategy/fibonacci":129,"events":17,"util":39}],128:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var util = require('util');

var BackoffStrategy = require('./strategy');

/**
 * Exponential backoff strategy.
 * @extends BackoffStrategy
 */
function ExponentialBackoffStrategy(options) {
    BackoffStrategy.call(this, options);
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
}
util.inherits(ExponentialBackoffStrategy, BackoffStrategy);

/** @inheritDoc */
ExponentialBackoffStrategy.prototype.next_ = function() {
    this.backoffDelay_ = Math.min(this.nextBackoffDelay_, this.getMaxDelay());
    this.nextBackoffDelay_ = this.backoffDelay_ * 2;
    return this.backoffDelay_;
};

/** @inheritDoc */
ExponentialBackoffStrategy.prototype.reset_ = function() {
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
};

module.exports = ExponentialBackoffStrategy;

},{"./strategy":130,"util":39}],129:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var util = require('util');

var BackoffStrategy = require('./strategy');

/**
 * Fibonacci backoff strategy.
 * @extends BackoffStrategy
 */
function FibonacciBackoffStrategy(options) {
    BackoffStrategy.call(this, options);
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
}
util.inherits(FibonacciBackoffStrategy, BackoffStrategy);

/** @inheritDoc */
FibonacciBackoffStrategy.prototype.next_ = function() {
    var backoffDelay = Math.min(this.nextBackoffDelay_, this.getMaxDelay());
    this.nextBackoffDelay_ += this.backoffDelay_;
    this.backoffDelay_ = backoffDelay;
    return backoffDelay;
};

/** @inheritDoc */
FibonacciBackoffStrategy.prototype.reset_ = function() {
    this.nextBackoffDelay_ = this.getInitialDelay();
    this.backoffDelay_ = 0;
};

module.exports = FibonacciBackoffStrategy;

},{"./strategy":130,"util":39}],130:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

function isDef(value) {
    return value !== undefined && value !== null;
}

/**
 * Abstract class defining the skeleton for all backoff strategies.
 * @param options Backoff strategy options.
 * @param options.randomisationFactor The randomisation factor, must be between
 * 0 and 1.
 * @param options.initialDelay The backoff initial delay, in milliseconds.
 * @param options.maxDelay The backoff maximal delay, in milliseconds.
 * @constructor
 */
function BackoffStrategy(options) {
    options = options || {};

    if (isDef(options.initialDelay) && options.initialDelay < 1) {
        throw new Error('The initial timeout must be greater than 0.');
    } else if (isDef(options.maxDelay) && options.maxDelay < 1) {
        throw new Error('The maximal timeout must be greater than 0.');
    }

    this.initialDelay_ = options.initialDelay || 100;
    this.maxDelay_ = options.maxDelay || 10000;

    if (this.maxDelay_ <= this.initialDelay_) {
        throw new Error('The maximal backoff delay must be ' +
                        'greater than the initial backoff delay.');
    }

    if (isDef(options.randomisationFactor) &&
        (options.randomisationFactor < 0 || options.randomisationFactor > 1)) {
        throw new Error('The randomisation factor must be between 0 and 1.');
    }

    this.randomisationFactor_ = options.randomisationFactor || 0;
}

/**
 * Retrieves the maximal backoff delay.
 * @return The maximal backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.getMaxDelay = function() {
    return this.maxDelay_;
};

/**
 * Retrieves the initial backoff delay.
 * @return The initial backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.getInitialDelay = function() {
    return this.initialDelay_;
};

/**
 * Template method that computes the next backoff delay.
 * @return The backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.next = function() {
    var backoffDelay = this.next_();
    var randomisationMultiple = 1 + Math.random() * this.randomisationFactor_;
    var randomizedDelay = Math.round(backoffDelay * randomisationMultiple);
    return randomizedDelay;
};

/**
 * Computes the next backoff delay.
 * @return The backoff delay, in milliseconds.
 * @protected
 */
BackoffStrategy.prototype.next_ = function() {
    throw new Error('BackoffStrategy.next_() unimplemented.');
};

/**
 * Template method that resets the backoff delay to its initial value.
 */
BackoffStrategy.prototype.reset = function() {
    this.reset_();
};

/**
 * Resets the backoff delay to its initial value.
 * @protected
 */
BackoffStrategy.prototype.reset_ = function() {
    throw new Error('BackoffStrategy.reset_() unimplemented.');
};

module.exports = BackoffStrategy;

},{"events":17,"util":39}],131:[function(require,module,exports){
(function (process){
var through = require('through')
var isBuffer = require('isbuffer')
var WebSocketPoly = require('ws')

function WebsocketStream(server, options) {
  if (!(this instanceof WebsocketStream)) return new WebsocketStream(server, options)

  this.stream = through(this.write.bind(this), this.end.bind(this))

  this.stream.websocketStream = this
  this.options = options || {}
  this._buffer = []

  if (typeof server === "object") {
    this.ws = server
    this.ws.on('message', this.onMessage.bind(this))
    this.ws.on('error', this.onError.bind(this))
    this.ws.on('close', this.onClose.bind(this))
    this.ws.on('open', this.onOpen.bind(this))
    if (this.ws.readyState === 1) this._open = true
  } else {
    var opts = (process.title === 'browser') ? this.options.protocol : this.options
    this.ws = new WebSocketPoly(server, opts)
    this.ws.binaryType = this.options.binaryType || 'arraybuffer'
    this.ws.onmessage = this.onMessage.bind(this)
    this.ws.onerror = this.onError.bind(this)
    this.ws.onclose = this.onClose.bind(this)
    this.ws.onopen = this.onOpen.bind(this)
  }

  return this.stream
}

module.exports = WebsocketStream
module.exports.WebsocketStream = WebsocketStream

WebsocketStream.prototype.onMessage = function(e) {
  var data = e
  if (typeof data.data !== 'undefined') data = data.data

  // type must be a Typed Array (ArrayBufferView)
  var type = this.options.type
  if (type && data instanceof ArrayBuffer) data = new type(data)

  this.stream.queue(data)
}

WebsocketStream.prototype.onError = function(err) {
  this.stream.emit('error', err)
}

WebsocketStream.prototype.onClose = function(err) {
  if (this._destroy) return
  this.stream.emit('end')
  this.stream.emit('close')
}

WebsocketStream.prototype.onOpen = function(err) {
  if (this._destroy) return
  this._open = true
  for (var i = 0; i < this._buffer.length; i++) {
    this._write(this._buffer[i])
  }
  this._buffer = undefined
  this.stream.emit('open')
  this.stream.emit('connect')
  if (this._end) this.ws.close()
}

WebsocketStream.prototype.write = function(data) {
  if (!this._open) {
    this._buffer.push(data)
  } else {
    this._write(data)
  }
}

WebsocketStream.prototype._write = function(data) {
  if (this.ws.readyState == 1)
    // we are connected
    typeof WebSocket != 'undefined' && this.ws instanceof WebSocket
      ? this.ws.send(data)
      : this.ws.send(data, { binary : isBuffer(data) })
  else
    this.stream.emit('error', 'Not connected')
}

WebsocketStream.prototype.end = function(data) {
  if (data !== undefined) this.stream.queue(data)
  if (this._open) this.ws.close()
  this._end = true
}

}).call(this,require('_process'))
},{"_process":19,"isbuffer":132,"through":133,"ws":134}],132:[function(require,module,exports){
var Buffer = require('buffer').Buffer;

module.exports = isBuffer;

function isBuffer (o) {
  return Buffer.isBuffer(o)
    || /\[object (.+Array|Array.+)\]/.test(Object.prototype.toString.call(o));
}

},{"buffer":12}],133:[function(require,module,exports){
(function (process){
var Stream = require('stream')

// through
//
// a stream that does nothing but re-emit the input.
// useful for aggregating a series of changing but not ending streams into one stream)

exports = module.exports = through
through.through = through

//create a readable writable stream.

function through (write, end, opts) {
  write = write || function (data) { this.queue(data) }
  end = end || function () { this.queue(null) }

  var ended = false, destroyed = false, buffer = [], _ended = false
  var stream = new Stream()
  stream.readable = stream.writable = true
  stream.paused = false

//  stream.autoPause   = !(opts && opts.autoPause   === false)
  stream.autoDestroy = !(opts && opts.autoDestroy === false)

  stream.write = function (data) {
    write.call(this, data)
    return !stream.paused
  }

  function drain() {
    while(buffer.length && !stream.paused) {
      var data = buffer.shift()
      if(null === data)
        return stream.emit('end')
      else
        stream.emit('data', data)
    }
  }

  stream.queue = stream.push = function (data) {
//    console.error(ended)
    if(_ended) return stream
    if(data === null) _ended = true
    buffer.push(data)
    drain()
    return stream
  }

  //this will be registered as the first 'end' listener
  //must call destroy next tick, to make sure we're after any
  //stream piped from here.
  //this is only a problem if end is not emitted synchronously.
  //a nicer way to do this is to make sure this is the last listener for 'end'

  stream.on('end', function () {
    stream.readable = false
    if(!stream.writable && stream.autoDestroy)
      process.nextTick(function () {
        stream.destroy()
      })
  })

  function _end () {
    stream.writable = false
    end.call(stream)
    if(!stream.readable && stream.autoDestroy)
      stream.destroy()
  }

  stream.end = function (data) {
    if(ended) return
    ended = true
    if(arguments.length) stream.write(data)
    _end() // will emit or queue
    return stream
  }

  stream.destroy = function () {
    if(destroyed) return
    destroyed = true
    ended = true
    buffer.length = 0
    stream.writable = stream.readable = false
    stream.emit('close')
    return stream
  }

  stream.pause = function () {
    if(stream.paused) return
    stream.paused = true
    return stream
  }

  stream.resume = function () {
    if(stream.paused) {
      stream.paused = false
      stream.emit('resume')
    }
    drain()
    //may have become paused again,
    //as drain emits 'data'.
    if(!stream.paused)
      stream.emit('drain')
    return stream
  }
  return stream
}


}).call(this,require('_process'))
},{"_process":19,"stream":35}],134:[function(require,module,exports){
arguments[4][121][0].apply(exports,arguments)
},{"dup":121}],"kurento-client":[function(require,module,exports){
/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var checkType = require('checktype');

var MediaObjectCreator = require('./MediaObjectCreator');
var register = require('./register');
var TransactionsManager = require('./TransactionsManager');

exports.checkType = checkType;
exports.MediaObjectCreator = MediaObjectCreator;
exports.register = register;
exports.TransactionsManager = TransactionsManager;

// Export KurentoClient

var KurentoClient = require('./KurentoClient');

module.exports = KurentoClient;
KurentoClient.KurentoClient = KurentoClient;

// Ugly hack due to circular references

KurentoClient.checkType = checkType;
KurentoClient.MediaObjectCreator = MediaObjectCreator;
KurentoClient.register = register;
KurentoClient.TransactionsManager = TransactionsManager;

// Register Kurento basic elements

register(require('kurento-client-core'))
register(require('kurento-client-elements'))
register(require('kurento-client-filters'))

},{"./KurentoClient":1,"./MediaObjectCreator":2,"./TransactionsManager":3,"./register":6,"checktype":8,"kurento-client-core":88,"kurento-client-elements":106,"kurento-client-filters":113}]},{},[4]);
