//https://github.com/slimjack/IWC-SignalR
(function (scope) {
    var registeredProxies = {};
    var isConnectionOwner = false;
    var isSynchronized = false;
    var isInitialized = false;
    var deferredStartResult = $.Deferred();
    var serverInvocationDeferredResults = {};
    var lsPrefix = SJ.iwc.getLocalStoragePrefix() + '_SIGNALR_';
    var proxyClientsConfig = new SJ.iwc.SharedData(lsPrefix + 'CLIENTS');

    var iwcSignalRVersion = '0.1';
    SJ.localStorage.setVersion(lsPrefix, iwcSignalRVersion);

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
        var startArgs = Array.prototype.slice.call(arguments, 0);
        if (isConnectionOwner) {
            var result = $.connection.hub.start.apply($.connection.hub, startArgs);
            onHubDeferredStart(result);
            return result;
        } else {
            var result = $.Deferred();
            SJ.iwc.WindowMonitor.onReady(function () {
                updateDeferredStartResult();

                if (!isSynchronized) {
                    isSynchronized = true;
                    SJ.lock('IWC_SIGNALR', function () {
                        isConnectionOwner = true;
                        proxyClientsConfig.onChanged(function (data) {
                            if (!data) {
                                return;
                            }
                            if (applyProxyClientsConfig(data)) {
                                onHubDeferredStart($.connection.hub.start.apply($.connection.hub, startArgs));
                            }
                        });
                        var clientsConfig = proxyClientsConfig.get();
                        if (clientsConfig) {
                            clientsConfig = removeObsoleteClientsConfigs(clientsConfig);
                            applyProxyClientsConfig(clientsConfig);
                            proxyClientsConfig.change(removeObsoleteClientsConfigs);
                        }
                        subscribeOnServerRequests();
                        configureRealHubProxies();
                        subscribeConnectionEvents();
                        onHubDeferredStart($.connection.hub.start.apply($.connection.hub, startArgs));
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
        if (!isConnectionOwner)
            throw "Invalid operation - onHubConnectionStarted is allowed only for connection owner";
        var startedResult = {
            success: success,
            errorMsg: errorMsg,
            windowId: SJ.iwc.WindowMonitor.getThisWindowId()
        };
        SJ.localStorage.setItem(lsPrefix + 'STARTEDRESULT', JSON.stringify(startedResult));
        SJ.iwc.EventBus.fire('signalrconnectionstarted', success, errorMsg);
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
        var hubProxy;
        if (registeredProxies[proxyName]) {
            var client = registeredProxies[proxyName].client;
            for (var propName in client) {
                if (SJ.isFunction(proxyConfig.client[propName]) && client[propName] === SJ.emptyFn) {
                    client[propName] = proxyConfig.client[propName];
                }
            }
            for (var propName in proxyConfig.client) {
                if (SJ.isFunction(proxyConfig.client[propName]) && !client[propName]) {
                    client[propName] = proxyConfig.client[propName];
                }
            }
            hubProxy = registeredProxies[proxyName];
        } else {
            hubProxy = {
                name: proxyName,
                client: proxyConfig.client,
                server: getProxyServer(proxyName)
            };
            registeredProxies[proxyName] = hubProxy;
        }
        proxyClientsConfig.change(function (data) {
            data = data || {};
            data[proxyName] = data[proxyName] || { windows: [], methods: [] };

            var windows = data[proxyName].windows;
            var thisWindowId = SJ.iwc.WindowMonitor.getThisWindowId();
            if (windows.indexOf(thisWindowId) === -1) {
                windows.push(thisWindowId);
            }

            var methods = data[proxyName].methods;
            for (var propName in proxyConfig.client) {
                if (proxyConfig.client.hasOwnProperty(propName) && SJ.isFunction(proxyConfig.client[propName])) {
                    if (methods.indexOf(propName) === -1) {
                        methods.push(propName);
                    }
                }
            }
            return data;
        });
        return hubProxy;
    };

    function applyProxyClientsConfig(data) {
        var isConfigChanged = false;
        for (var proxyName in data) {
            if (data.hasOwnProperty(proxyName)) {
                var proxy = registeredProxies[proxyName];
                if (!proxy) {
                    proxy = {
                        name: proxyName,
                        client: {},
                        server: getProxyServer(proxyName)
                    };
                    registeredProxies[proxyName] = proxy;
                }
                data[proxyName].methods.forEach(function (methodName) {
                    if (!proxy.client[methodName]) {
                        isConfigChanged = true;
                        proxy.client[methodName] = SJ.emptyFn;
                    } else if (!proxy.client._applied || !proxy.client._applied[methodName]) {
                        isConfigChanged = true;
                    }
                });
            }
        }
        if (isConfigChanged) {
            configureRealHubProxies();
        }
        return isConfigChanged;
    };

    function removeObsoleteClientsConfigs(clientsConfig) {
        for (var proxyName in clientsConfig) {
            if (clientsConfig.hasOwnProperty(proxyName)) {
                var isConfigChanged = false;
                var filteredWindows = [];
                clientsConfig[proxyName].windows.forEach(function (windowId) {
                    if (SJ.iwc.WindowMonitor.isWindowOpen(windowId)) {
                        filteredWindows.push(windowId);
                    } else {
                        isConfigChanged = true;
                    }
                });
                if (isConfigChanged) {
                    if (filteredWindows.length) {
                        clientsConfig[proxyName].windows = filteredWindows;
                    } else {
                        delete clientsConfig[proxyName];
                    }
                }
            }
        }
        return clientsConfig;
    };

    function configureRealProxyClient(proxy) {
        var realProxy = $.connection[proxy.name];
        for (var propName in proxy.client) {
            if (proxy.client.hasOwnProperty(propName) && SJ.isFunction(proxy.client[propName]) && !realProxy.client[propName]) {
                configureRealProxyClientMethod(proxy, realProxy, propName);
                proxy.client._applied = proxy.client._applied || {};
                proxy.client._applied[propName] = true;
            }
        }
    };

    function configureRealProxyClientMethod(proxy, realProxy, methodName) {
        realProxy.client[methodName] = function () {
            proxy.client[methodName].apply(this, arguments);
            var eventArgs = ['signalrclientinvoke', proxy.name, methodName].concat(Array.prototype.slice.call(arguments, 0));
            SJ.iwc.EventBus.fire.apply(SJ.iwc.EventBus, eventArgs);
        };
    }

    function onClientInvoke(proxyName, methodname) {
        if (!isConnectionOwner && registeredProxies[proxyName] && registeredProxies[proxyName].client[methodname]) {
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
        if (!isConnectionOwner)
            throw "Invalid operation - updateState is allowed only for connection owner";
        var stateData = {
            state: state,
            connectionId: $.connection.hub.id,
            windowId: SJ.iwc.WindowMonitor.getThisWindowId()
        };
        SJ.localStorage.setItem(lsPrefix + 'STATE', JSON.stringify(stateData));
    };

    function getStateData() {
        var result = null;
        var serializedData = SJ.localStorage.getItem(lsPrefix + 'STATE');
        if (serializedData) {
            var stateData = JSON.parse(serializedData);
            if (SJ.iwc.WindowMonitor.isWindowOpen(stateData.windowId)) {
                result = stateData;
            }
        }

        return result;
    };

    function getState() {
        var state = $.connection.connectionState.disconnected;
        var stateData = getStateData();
        if (stateData) {
            state = stateData.state;
        }

        return state;
    };

    function getConnectionId() {
        var result = null;
        var stateData = getStateData();
        if (stateData) {
            result = stateData.connectionId;
        }

        return result;
    };

    function getConnectionOwnerWindowId() {
        var result = null;
        var serializedData = SJ.localStorage.getItem(lsPrefix + 'STATE');
        if (serializedData) {
            var stateData = JSON.parse(serializedData);
            if (SJ.iwc.WindowMonitor.isWindowOpen(stateData.windowId)) {
                result = stateData.windowId;
            }
        }

        return result;
    };

    //endregion
    var IWCSignalR = {
        getHubProxy: getHubProxy,
        start: start,
        getState: getState,
        getConnectionId: getConnectionId,
        isConnectionOwner: function() {
             return isConnectionOwner;
        },
        getConnectionOwnerWindowId: getConnectionOwnerWindowId
    };
    var observable = SJ.utils.Observable.decorate(IWCSignalR, true);
    SJ.copy(scope, IWCSignalR);
})(SJ.ns('iwc.SignalR'));
