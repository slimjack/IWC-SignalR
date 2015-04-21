//This patch allows to start SignalR multiple times. This allows to reconfigure hub proxies at any time
(function () {
    var vars = {
        deferredStartResult: $.Deferred(),
        isStarting: false,
        observable: new SJ.utils.Observable(),
        defferedServerCalls: [],
        isProxiesUpdated: false,
        originalStart: $.connection.hub.start
    };

    //region Applying of the patch to SignalR
    $.connection.hub.start = start;
    $.connection.hub.connected = function (callback) {
        vars.observable.on('connected', callback, $.connection.hub);
    };
    //endregion

    //region Common
    $.connection.hub.stateChanged(function (changes) {
        vars.observable.fire('statechanged', changes.newState, changes.oldState);
        switch (changes.newState) {
            case $.signalR.connectionState.connected:
                vars.observable.fire('connected');
                executeDefferedCalls();
                break;
            case $.signalR.connectionState.disconnected:
                vars.observable.fire('disconnected');
                break;
        }
    });
    //endregion

    //region Patch for hub proxies
    function updateProxies() {
        for (var propName in $.connection) {
            if ($.connection[propName].hubName === propName.toLowerCase()) {
                var proxyName = propName;
                fixServerMethods(proxyName);
            }
        }
    };

    //fixServerMethods allows to call server methods even if connection is not currently established.
    //If SignalR is not connected, server calls are buffered and will be executed when connection is established
    function fixServerMethods(proxyName) {
        var hubProxy = $.connection[proxyName];
        if (hubProxy.server.isFixed) {
            return;
        }
        var wrap = function (methodName) {
            var originalMethod = hubProxy.server[methodName];
            hubProxy.server[methodName] = function () {
                if ($.connection.hub.state === $.signalR.connectionState.connected) {
                    return originalMethod.apply(this, arguments);
                } else {
                    defferedObj = $.Deferred();
                    vars.defferedServerCalls.push({
                        proxyName: proxyName,
                        methodName: methodName,
                        defferedObj: defferedObj,
                        args: Array.prototype.slice.call(arguments, 0)
                    });
                    return defferedObj.promise();
                }
            };
        };
        for (var methodName in hubProxy.server) {
            if (hubProxy.server.hasOwnProperty(methodName) && SJ.isFunction(hubProxy.server[methodName])) {
                wrap(methodName);
            }
        }
        hubProxy.server.isFixed = true;
    };

    function executeDefferedCalls() {
        while (vars.defferedServerCalls.length && $.connection.hub.state === $.signalR.connectionState.connected) {
            var serverCall = vars.defferedServerCalls.shift();
            var hubProxy = $.connection[serverCall.proxyName];
            var promise = hubProxy.server[serverCall.methodName].apply(hubProxy.server, serverCall.args);
            forwardDefferedEvents(serverCall.defferedObj, promise);
        }
    };

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

    //region 'start' method patch
    function start() {
        if (!vars.isProxiesUpdated) {
            vars.isProxiesUpdated = true;
            updateProxies();
        }

        if (vars.deferredStartResult.state() !== 'pending') {
            vars.deferredStartResult = $.Deferred();
        }

        if ($.connection.hub.state === $.signalR.connectionState.disconnected) {
            startConnection.apply(this, arguments);
        } else {
            stopConnection(function () {
                startConnection.apply(this, arguments);
            });
        }
        return vars.deferredStartResult.promise();
    };

    function startConnection() {
        var args = arguments;
        if (!vars.isStarting) {
            vars.isStarting = true;
            window.setTimeout(function () {
                $.connection.hub._.lastMessageAt = new Date().getTime();
                $.connection.hub._.lastActiveAt = new Date().getTime();
                delete $.connection.hub._deferral;
                vars.originalStart.apply($.connection.hub, args)
                    .done(function () {
                        vars.isStarting = false;
                        vars.deferredStartResult.resolveWith(this, arguments);
                    })
                    .fail(function () {
                        vars.isStarting = false;
                        vars.deferredStartResult.rejectWith(this, arguments);
                    });
            });
        } else {
            if (vars.deferredStartResult.state() === 'pending') {
                vars.originalStart.apply($.connection.hub, args);
            }
        }
    };

    function stopConnection(callback) {
        var onDisconnected = function () {
            vars.isStarting = false;
            callback();
        };
        var doDisconnect = function () {
            vars.observable.once('disconnected', onDisconnected);
            $.connection.hub.stop();
        };

        if ($.connection.hub.state === $.signalR.connectionState.connected) {
            doDisconnect();
        } else if ($.connection.hub.state === $.signalR.connectionState.disconnected) {
            onDisconnected();
        } else {
            vars.observable.once('connected', function () {
                doDisconnect();
            });
        }
    };
    //endregion
})();