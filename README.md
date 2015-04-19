![](/icon.png) IWC-SignalR
===

Browsers have a limitation of the maximum number of connections to the same host address (same application).
So, this limits the maximum number of opened browser windows of the same application with SignalR connections.
**IWC-SignalR** allows to bypass this restriction using single SignalR connection for all windows of the same application.

#How it works
One of the windows becomes a connection owner (choosen randomly) and holds the real SignalR connection.
If connection owner is closed or crashed another window becomes a connection owner - this happens automatically.
Inter-window communication is done by means of [IWC](https://github.com/slimjack/IWC).

#Usage
To use **IWC-SignalR** include *signalr-patch.js* and *iwc-signalr.js* files on your page. *signalr-patch.js* allows to start SignalR multiple times. This allows to reconfigure hub proxies at any time.

Let's have a hub `Echo` with method `Send` defined on server. Method `Send` calls method `displayMsg` of all clients.

```js
var echoHub = SJ.iwc.SignalR.getHubProxy('echo', {
    client: {
        displayMsg: function (msg) {
          console.log(msg);
        }
    }
});
SJ.iwc.SignalR.start().done(function () {
    console.log('started');
    echoHub.server.send('test').done(function () {
        console.log('sent');
    });
});
//Result in console:
//started
//test
//sent
```

#Dependencies
**IWC-SignalR** depends on [**IWC**](https://github.com/slimjack/IWC)


#API

####Connection starting
`SJ.iwc.SignalR.start()`

######Parameters and return value:
This function has the same signature as the original `$.connection.hub.start` function

######Description:
`SJ.iwc.SignalR.start` when called it tries to find connection owner and connect to it via **IWC**.
If connection owner not found, real SignalR connection is established and this window becomes a connection owner.

####Obtaining hub proxy
`SJ.iwc.SignalR.getHubProxy({string}hubName, {object}hubClientConfig)`

######Parameters:
- `hubName` - hub name according to SignalR naming convention (starts from lower case letter)
- `hubClientConfig` - object which contains definition of client's methods

######Return value:
Returns hub proxy object with server and client

######Description:
Creates hub proxy object with server and client. Usage of server and client doesn't depend on whether the SignalR connection is real or via **IWC**.

######Example:
```js
var echoHub = SJ.iwc.SignalR.getHubProxy('echo', {
    client: {
        displayMsg: function (msg) {
          console.log(msg);
        }
    }
});

echoHub.server.send('test');
```

####Current state
`SJ.iwc.SignalR.getState()`

######Return value:
Returns connection state (see SignalR's `$.connection.connectionState` for available values)

######Description:
Returns the state of real SignalR connection

####Events
Use `SJ.iwc.SignalR.on()` and `SJ.iwc.SignalR.un()` to subscribe/unsubscribe on events

- `statechanged(newState, prevState)` - fired when connection state is changed. `newState`, `prevState` - new and previous state (see SignalR's `$.connection.connectionState` for available values)
- `connected` - fired when state is changed to `$.connection.connectionState.connected`
- `starting`, `received`, `connectionslow`, `reconnecting`, `reconnected`, `disconnected` - are the same events as for original SignalR connection

######Example:
```js
var someObject = {
    onStateChanged: function (newState, prevState) {
    }
};
//subscribe
SJ.iwc.SignalR.on('statechanged', someObject.onStateChanged, someObject);
//unsubscribe
SJ.iwc.SignalR.un('statechanged', someObject.onStateChanged, someObject);
```
