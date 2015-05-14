function getopts(args, opts) {
  var result = opts.default || {};
  args.replace(
      new RegExp("([^?=&]+)(=([^&]*))?", "g"),
      function($0, $1, $2, $3) { result[$1] = $3; });
  return result;
};

var args = getopts(location.search, {
  default: {
    ws_uri: 'ws://' + location.hostname + ':8888/kurento',
    ice_servers: undefined
  }
});

if (args.ice_servers) {
  console.log("Use ICE servers: " + args.ice_servers);
  kurentoUtils.WebRtcPeer.prototype.server.iceServers = JSON.parse(args.ice_servers);
} else {
  console.log("Use freeice")
}

var options;
var webRtcPeer
var processAnswerCallback;

var mediaPipeline;
var composite;
var webRtcEndpoint;
var hubPort;

window.addEventListener("load", function(event) {
  var videoInput = document.getElementById('videoInput');
  var videoOutput = document.getElementById('videoOutput');
  var startButton = document.getElementById("start");
  var stopButton = document.getElementById("stop");
  stopButton.addEventListener("click", stop);

  options = {
    localVideo: videoInput,
    remoteVideo: videoOutput,
    configuration: {
      iceServers: []
    },
    mediaConstraints:  {
      audio: true,
      video: {
        mandatory: {
          minWidth: 960,
          maxWidth: 960,
          minHeight: 720,
          maxHeight: 720,
          minFrameRate: 15,
          maxFrameRate: 30
        },
        optional: []
      }
    }
  }

  // Initialize pipeline (only once).
  kurentoClient(args.ws_uri, options, function(error, kurentoClient) {
    if (error) return onerror(error);

    kurentoClient.create("MediaPipeline", function(error, _mediaPipeline) {
      if (error) return onerror(error);
      mediaPipeline = _mediaPipeline;

      mediaPipeline.create('Composite', function(error, _composite) {
        if (error) return onerror(error);
        composite = _composite;
      });
    });
  });

  startButton.addEventListener("click", function start() {
    console.log("WebRTC loopback starting");
    showSpinner(videoInput, videoOutput);

    webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, function (error) {
      if (error) return onerror(error);

      this.generateOffer(function (error, sdpOffer, _processAnswerCallback) {
        if (error) return onerror(error);
        processAnswerCallback = _processAnswerCallback;
      })

      // HACK: wait until SDP offer contains ICE candidates.
      // kurento-client.js doesn't fully support this part of ICE trickle yet (?)
      setTimeout(function() {
        sdpOffer = webRtcPeer.peerConnection.localDescription.sdp;

        mediaPipeline.create("WebRtcEndpoint", function(error, _webRtcEndpoint){
          if (error) return onerror(error);
          webRtcEndpoint = _webRtcEndpoint;

          webRtcEndpoint.setMinVideoSendBandwidth(0, function(error, result) {
            if (error) return onerror(error);
            console.log('set');

            webRtcEndpoint.setMaxVideoSendBandwidth(0, function(error, result) {
              if (error) return onerror(error);
              console.log('set');

              webRtcEndpoint.setMaxVideoRecvBandwidth(0, function(error, result) {
                if (error) return onerror(error);
                console.log('set');

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                  webRtcPeer.addIceCandidate(event.candidate, function(error) {
                    if (error) return onerror(error);
                    console.log(event.candidate);
                  });
                });

                composite.createHubPort(function(error, _hubPort) {
                  if (error) return onerror(error);
                  hubPort = _hubPort;

                  webRtcEndpoint.connect(hubPort, function(error) {
                    if (error) return onerror(error);

                    hubPort.connect(webRtcEndpoint, function(error) {
                      if (error) return onerror(error);

                      webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) return onerror(error);

                        webRtcEndpoint.gatherCandidates(function(error, result) {
                          if (result) console.log(result);
                          console.log('Gathering candidates...');
                        });

                        processAnswerCallback(sdpAnswer, function(error) {
                          if (error) return onerror(error);
                          console.log('Answer processed');
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      }, 3000);
    });
  });
});

function stop() {
  if (webRtcEndpoint) {
    webRtcEndpoint.release();
    webRtcEndpoint = null;
  }
  if (hubPort) {
    hubPort.release();
    hubPort = null;
  }
  hideSpinner(videoInput, videoOutput);
}

function onerror(error) {
  if (error) console.log(error);
}

function showSpinner() {
  for (var i = 0; i < arguments.length; i++) {
    arguments[i].poster = 'transparent-1px.png';
    arguments[i].style.background = "center transparent url('spinner.gif') no-repeat";
  }
}

function hideSpinner() {
  for (var i = 0; i < arguments.length; i++) {
    arguments[i].src = '';
    arguments[i].poster = 'webrtc.png';
    arguments[i].style.background = '';
  }
}

