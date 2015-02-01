//Methods:
//    start() - returns deferred result.
//      because they are executed whether it's a real connection or IWC connection
//    getHubProxy(proxyName, proxyConfig) - returns wrapped hub proxy
//      proxyConfig: {
//          client: {
//              handler1: function() {...},
//              handler2: function() {...},
//              ...
//          }
//      }
//      client - configuration of client methods. The same as for real hub proxy
//    getState() - returns current connection state. See $.connection.connectionState for available values
//Events:
//    statechanged(newState, prevState) - See $.connection.connectionState for available state values
//    connected - fired when state is changed to $.connection.connectionState.connected
//    starting, received, connectionslow, reconnecting, reconnected, disconnected - are the same events as for real SignalR connection
//
//Example:
//Let's have a hub 'Echo' with method 'Send' defined on server. Method 'Send' calls method 'displayMsg' for all clients
//
//var echoHub = SJ.iwc.SignalR.getHubProxy('echo', {
//    client: {
//        displayMsg: function (msg) {
//          console.log(msg);
//        }
//    }
//});
//SJ.iwc.SignalR.on('connected', function () {
//    console.log('joined');
//    echoHub.server.join();
//});
//SJ.iwc.SignalR.start().done(function () {
//    console.log('started');
//    echoHub.server.send('test').done(function () {
//        console.log('sent');
//    });
//});
//Result in console:
//joined
//started
//test
//sent
(function (scope) {
    var registeredProxies = {};
    var isConnectionOwner = false;
    var isSynchronized = false;
    var isInitialized = false;
    var deferredStartResult = $.Deferred();
    var serverInvocationDeferredResults = {};
    var lsPrefix = SJ.iwc.getLocalStoragePrefix() + '_SIGNALR_';
    //region Utility functions
    function forwardDefferedEvents(targetDeferred, srcPromise) {
        srcPromise.done(function () {
            targetDeferred.resolveWith(this, arguments);
        });
        srcPromise.fail(function () {
            targetDeferred.rejectWith(this, arguments);
        });
        srcPromise.progress(function () {
            targetDeferred.notifyWith(this, arguments);
        });
    };
    //endregion

    //region Init
    function init() {
        if (isInitialized) {
            return;
        }
        isInitialized = true;
        SJ.windowOn('unload', function () {
            if (isConnectionOwner) {
                SJ.localStorage.removeItem(lsPrefix + 'STARTEDRESULT');
                $.connection.hub.stop();
            }
        });

        SJ.iwc.EventBus.on('signalrclientinvoke', onClientInvoke, null, true);
        SJ.iwc.EventBus.on('signalrserverresponse', onServerResponse, null, true);

        SJ.iwc.EventBus.on('signalrconnectionstarted', onConnectionStarted, null, true);

        SJ.iwc.EventBus.on('signalrstatechanged', onStateChanged, null, true);
        SJ.iwc.EventBus.on('signalrconnectionstarting', onStarting, null, true);
        SJ.iwc.EventBus.on('signalrconnectionreceived', onReceived, null, true);
        SJ.iwc.EventBus.on('signalrconnectionslow', onConnectionSlow, null, true);
        SJ.iwc.EventBus.on('signalrconnectionreconnecting', onReconnecting, null, true);
        SJ.iwc.EventBus.on('signalrconnectionreconnected', onReconnected, null, true);
        SJ.iwc.EventBus.on('signalrconnectiondisconnected', onDisconnected, null, true);
    };
    //endregion

    //region Hub starting
    function start() {
        init();

        if (isConnectionOwner) {
            var result = $.connection.hub.start();
            subscribeDeferredHubStartResult(result);
            return result;
        } else {
            var result = $.Deferred();
            SJ.iwc.WindowMonitor.onReady(function () {
                updateDeferredStartResult();

                if (!isSynchronized) {
                    isSynchronized = true;
                    SJ.lock('IWC_SIGNALR', function () {
                        isConnectionOwner = true;
                        console.log('Connection owned');
                        subscribeOnServerRequests();
                        configureRealHubProxies();
                        subscribeConnectionEvents();
                        onHubDeferredStart($.connection.hub.start());
                    });
                }
                forwardDefferedEvents(result, deferredStartResult.promise());
            });
            return result.promise();
        }
    };

    function updateDeferredStartResult() {
        var startedResult = getConnectionStartedResult();
        if (startedResult) {
            if (!isStartedResultEqualToDeferred(startedResult.success)) {
                deferredStartResult = $.Deferred();
            }
            if (startedResult.success) {
                deferredStartResult.resolve();
            } else {
                deferredStartResult.reject(startedResult.errorMsg);
            }
        } else if (deferredStartResult.state() !== "pending") {
            deferredStartResult = $.Deferred();
        }
    };

    function subscribeConnectionEvents() {
        $.connection.hub.starting(function () {
            SJ.iwc.EventBus.fire('signalrconnectionstarting');
        });
        $.connection.hub.received(function () {
            SJ.iwc.EventBus.fire('signalrconnectionreceived');
        });
        $.connection.hub.connectionSlow(function () {
            SJ.iwc.EventBus.fire('signalrconnectionslow');
        });
        $.connection.hub.reconnecting(function () {
            SJ.iwc.EventBus.fire('signalrconnectionreconnecting');
        });
        $.connection.hub.reconnected(function () {
            SJ.iwc.EventBus.fire('signalrconnectionreconnected');
        });
        $.connection.hub.disconnected(function () {
            SJ.iwc.EventBus.fire('signalrconnectiondisconnected');
        });
        $.connection.hub.stateChanged(onHubStateChanged);
    };

    function onHubDeferredStart(deferredResult) {
        deferredResult.done(function () {
            onHubConnectionStarted(true);
        })
        .fail(function (errorMsg) {
            onHubConnectionStarted(false, errorMsg);
        });
    };

    function onConnectionStarted(success, errorMessage) {
        if (success) {
            deferredStartResult.resolve();
        } else {
            deferredStartResult.reject(errorMessage);
        }
    };

    function getConnectionStartedResult() {
        var startedResult = null;
        var serializedData = SJ.localStorage.getItem(lsPrefix + 'STARTEDRESULT');
        if (serializedData) {
            startedResult = JSON.parse(serializedData);
            if (!SJ.iwc.WindowMonitor.isWindowOpen(startedResult.windowId)) {
                startedResult = null;
            }
        }

        return startedResult;
    };

    function isStartedResultEqualToDeferred(startedResultSuccess) {
        var deferredStartResultState = deferredStartResult.state();
        var deferredStartResultSuccess = deferredStartResultState === 'resolved';
        return (deferredStartResultState === "pending") || (startedResultSuccess === deferredStartResultSuccess);
    };

    function onHubConnectionStarted(success, errorMsg) {
        SJ.lock('IWC_SIGNALR_STARTEDRESULT', function () {
            var startedResult = {
                success: success,
                errorMsg: errorMsg,
                windowId: SJ.iwc.WindowMonitor.getThisWindowId()
            };
            SJ.localStorage.setItem(lsPrefix + 'STARTEDRESULT', JSON.stringify(startedResult));
            SJ.iwc.EventBus.fire('signalrconnectionstarted', success, errorMsg);
        });
    };

    function configureRealHubProxies() {
        for (var proxyName in registeredProxies) {
            if (registeredProxies.hasOwnProperty(proxyName)) {
                configureRealProxyClient(registeredProxies[proxyName]);
            }
        }
    };

    function subscribeOnServerRequests() {
        SJ.iwc.EventBus.on('signalrserverinvoke', onServerInvoke, null, true);
    };
    //endregion

    //region Hub proxy
    function getHubProxy(proxyName, proxyConfig) {
        if (registeredProxies[proxyName]) {
            return registeredProxies[proxyName];
        }
        var hubProxy = {
            name: proxyName,
            client: proxyConfig.client,
            server: getProxyServer(proxyName)
        };
        registeredProxies[proxyName] = hubProxy;
        return hubProxy;
    };

    function configureRealProxyClient(proxy) {
        var realProxy = $.connection[proxy.name];
        for (var propName in proxy.client) {
            if (proxy.client.hasOwnProperty(propName) && SJ.isFunction(proxy.client[propName])) {
                realProxy.client[propName] = function () {
                    proxy.client[propName].apply(this, arguments);
                    var methodName = propName;
                    var eventArgs = ['signalrclientinvoke', proxy.name, methodName].concat(Array.prototype.slice.call(arguments, 0));
                    SJ.iwc.EventBus.fire.apply(SJ.iwc.EventBus, eventArgs);
                };
            }
        }
    };

    function onClientInvoke(proxyName, methodname) {
        if (!isConnectionOwner && registeredProxies[proxyName]) {
            var args = Array.prototype.slice.call(arguments, 2);
            registeredProxies[proxyName].client[methodname].apply(registeredProxies[proxyName], args);
        }
    }

    function getProxyServer(proxyName) {
        var realProxy = $.connection[proxyName];
        var proxySrever = {};
        for (var propName in realProxy.server) {
            if (realProxy.server.hasOwnProperty(propName) && SJ.isFunction(realProxy.server[propName])) {
                proxySrever[propName] = getWrappedProxyServerFn(proxyName, propName);
            }
        }
        return proxySrever;
    };

    function getWrappedProxyServerFn(proxyName, methodName) {
        var realProxy = $.connection[proxyName];
        return function () {
            if (isConnectionOwner) {
                return realProxy.server[methodName].apply(realProxy.server, arguments);
            } else {
                var args = Array.prototype.slice.call(arguments, 0);
                return invokeServerMethod(proxyName, methodName, args);
            }
        };
    };

    function invokeServerMethod(proxyName, methodName, args) {
        var requestId = SJ.generateGUID();
        var eventArgs = ['signalrserverinvoke', proxyName, methodName, requestId].concat(args);
        SJ.iwc.EventBus.fire.apply(SJ.iwc.EventBus, eventArgs);
        var deferredResult = $.Deferred();
        serverInvocationDeferredResults[requestId] = deferredResult;
        return deferredResult.promise();
    };

    function onServerInvoke(proxyName, methodName, requestId) {
        var args = Array.prototype.slice.call(arguments, 3);
        if (registeredProxies[proxyName]) {
            registeredProxies[proxyName].server[methodName].apply(registeredProxies[proxyName], args)
                .done(function () {
                    var eventArgs = ['signalrserverresponse', requestId, true].concat(Array.prototype.slice.call(arguments, 0));
                    SJ.iwc.EventBus.fire.apply(SJ.iwc.EventBus, eventArgs);
                })
                .fail(function (errorMsg) {
                    SJ.iwc.EventBus.fire('signalrserverresponse', requestId, false, errorMsg);
                });
        }
    }

    function onServerResponse(requestId, success, errorMsg) {
        if (!isConnectionOwner && serverInvocationDeferredResults[requestId]) {
            if (success) {
                var args = Array.prototype.slice.call(arguments, 2);
                serverInvocationDeferredResults[requestId].resolve.apply(serverInvocationDeferredResults[requestId], args);
            } else {
                serverInvocationDeferredResults[requestId].reject(errorMsg);
            }
            delete serverInvocationDeferredResults[requestId];
        }
    };
    //endregion

    //region Connection state
    function onStateChanged(newState, prevState) {
        observable.fire('statechanged', newState, prevState);
        if (newState !== prevState && newState === $.signalR.connectionState.connected) {
            observable.fire('connected');
        }
    };

    function onStarting() {
        observable.fire('starting');
    };

    function onReceived() {
        observable.fire('received');
    };

    function onConnectionSlow() {
        observable.fire('connectionslow');
    };

    function onReconnecting() {
        observable.fire('reconnecting');
    };

    function onReconnected() {
        observable.fire('reconnected');
    };

    function onDisconnected() {
        observable.fire('disconnected');
    };

    function onHubStateChanged(changes) {
        updateState(changes.newState);
        SJ.iwc.EventBus.fire('signalrstatechanged', changes.newState, changes.oldState);
    };

    function updateState(state) {
        SJ.lock('IWC_SIGNALR_STATE', function () {
            var stateData = {
                state: state,
                windowId: SJ.iwc.WindowMonitor.getThisWindowId()
            };
            SJ.localStorage.setItem(lsPrefix + 'STATE', JSON.stringify(stateData));
        });
    };

    function getState() {
        var state = $.connection.connectionState.disconnected;
        var serializedData = SJ.localStorage.getItem(lsPrefix + 'STATE');
        if (serializedData) {
            var stateData = JSON.parse(serializedData);
            if (!SJ.iwc.WindowMonitor.isWindowOpen(stateData.windowId)) {
                state = stateData.state;
            }
        }

        return state;
    };
    //endregion
    var IWCSignalR = {
        getHubProxy: getHubProxy,
        start: start,
        getState: getState
    };
    var observable = SJ.utils.Observable.decorate(IWCSignalR, true);
    SJ.copy(scope, IWCSignalR);
})(SJ.ns('iwc.SignalR'));
