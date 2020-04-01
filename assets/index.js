// Screencast section

// WebRTC protocol
// Offer - Answer (exchanging descriptions - includes information about each peer)
// Exchange ICE Candidates (ways to connect)
// Connection is made and remote streams handled with ontrack

var localTracks = null; // this is what I stream as my tracks
var peerConnections = [];
var socket;
var isServer = false;
var resetCancelStreamingInterval;
var roomCode;
var playlist = []; // This is the playlist on the server. It gets sent to the clients
var playlistCursor = 0; // Same with this.
var remoteMidMap = {}; // this is the map of mids to track PAIRS as KEPT BY THE SERVER, but this is filled on the client
var midToTrackMap = {}; // map mids to tracks for the client
var midMapCounter = 0;
var remoteMidMapCounter = -1;
var musicVolume = 0.2;
var playNextVideoTimeout;
var RESET_CANCEL_STREAMING_INTERVAL = 1000; // let the server know we exist every second. It won't cancel until no response for 10 seconds.
var VIDEO_FETCH_TIMEOUT = 1000;

window.addEventListener('load', function() {
    // determine what we are - only used for button highlighting
    var urlParams = new URLSearchParams(window.location.search);
    if( urlParams.has("is_server") ) {
        isServer = true;
        document.querySelector("html").classList.add("is-server");
    }
    if( urlParams.has("room_code") ) {
        roomCode = decodeURIComponent(urlParams.get("room_code"));
    }

    // if the room code is specified in the url, just login.
    if( roomCode ) {
        socket = io.connect(window.location.protocol+"//"+window.location.hostname);
        socket.on("connect", function() {
            displayScreencast();
        });
    }
    else {
        document.querySelector('#splash button').onclick = login;
    }
});

/**
 * Setup the music stream.
 */
function setUpMusicStream() {
    var video = document.createElement("video");
    video.setAttribute("id", "music-stream");
    video.setAttribute("autoplay", "true");
    document.querySelector("body").appendChild(video);
    playNextVideo();
}

/**
 * Remove a track from a list.
 * @param {Array} list - The list of tracks.
 * @param {MediaStreamTrack} track - The tracks.
 */
function removeTrackFromList(list, track) {
    list.splice( list.indexOf(track), 1 );
}

/**
 * Draw the playlist.
 */
function drawPlaylist() {
    var playlistElement = document.querySelector(".playlist");
    var playlistSongs = document.querySelector(".playlist-songs");
    if( !playlistElement ) {
        playlistElement = document.createElement("div");
        playlistElement.classList.add("playlist");

        var playlistTitle = document.createElement("div");
        playlistTitle.classList.add("playlist-title");
        playlistTitle.innerText = "Playlist";
        playlistElement.appendChild(playlistTitle);

        playlistSongs = document.createElement("div");
        playlistSongs.classList.add("playlist-songs");
        playlistElement.appendChild(playlistSongs);

        var stopButton = document.createElement("button");
        stopButton.setAttribute("id", "stop-button");
        stopButton.innerText = "Stop";
        stopButton.onclick = function() {
            if( document.querySelector(".song.playing") ) {
                makeRequest("POST", "/playlist-cursor", {
                    roomCode: roomCode,
                    cursor: document.querySelectorAll(".song").length // go to the end of the list
                });
            }
        }
        playlistElement.appendChild(stopButton);

        var input = document.createElement("input");
        input.setAttribute("type", "text");
        input.setAttribute("placeholder", "YouTube URL");
        playlistElement.appendChild(input);

        var button = document.createElement("button");
        button.innerText = "Add";
        playlistElement.appendChild(button);
        var addToPlaylist = function() {
            button.onclick = function() {}
            makeRequest("POST", "/playlist", { url: input.value, roomCode: roomCode }, function() {
                input.value = "";
                button.onclick = addToPlaylist;
            }, function() {
                button.onclick = addToPlaylist;
            })
        }
        button.onclick = addToPlaylist;

        document.body.appendChild(playlistElement);

        var playlistToggler = document.createElement("button");
        playlistToggler.classList.add("playlist-toggler");
        playlistToggler.innerText = "🎵";
        playlistToggler.onclick = function() {
            if( playlistElement.classList.contains("visible") ) {
                playlistElement.classList.remove("visible");
                playlistToggler.innerText = "🎵";
            }
            else {
                playlistElement.classList.add("visible");
                playlistToggler.innerText = "X";
            }
        }
        document.body.appendChild(playlistToggler);
    }

    if( playlistCursor < playlist.length && playlistCursor >= 0 ) {
        document.querySelector("#stop-button").classList.add("visible");
    }
    else {
        document.querySelector("#stop-button").classList.remove("visible");
    }

    playlistSongs.innerHTML = "";
    for( var i=0; i<playlist.length; i++ ) {
        var song = document.createElement("div");
        song.classList.add("song");
        song.innerText = playlist[i].name;
        if( i<playlistCursor ) {
            song.classList.add("played");
        }
        if( i==playlistCursor ) {
            song.classList.add("playing");
        }
        song.onclick = function() {
            if( !this.classList.contains("playing") ) {
                makeRequest("POST", "/playlist-cursor", {
                    roomCode: roomCode,
                    cursor: Array.prototype.indexOf.call(playlistSongs.querySelectorAll(".song"), this)
                });
            }
        }
        playlistSongs.appendChild(song);
    }
}

/**
 * Update the playlist and alert the clients.
 * @param {Array} [pl] - The playlist.
 */
function updatePlaylist(pl) {
    if( !pl ) pl = playlist;
    playlist = pl;
    for( let peerConnection of peerConnections ) {
        socket.emit( "data", { id: peerConnection.id, data: {"playlist": playlist, "playlistCursor": playlistCursor}, roomCode: roomCode } );
    }
}

/**
 * Change the video being played.
 * @param {Number} cursor - The new playlist cursor.
 */
function changeVideo(cursor) {
    if( cursor != playlistCursor ) {
        clearTimeout(playNextVideoTimeout);
        playlistCursor = cursor;
        var musicStream = document.querySelector("#music-stream.streaming");
        if( musicStream ) {
            playlistCursor--; // we'll just call the onended function for the current music
            musicStream.onended();
            musicStream.onended = function() {};
            musicStream.onerror = function() {};
        }
        else {
            playNextVideo();
        }
    }
}

/**
 * Play the next video in the stream.
 */
function playNextVideo() {
    if( playlist[playlistCursor] ) {
        try {
            var musicStream = document.querySelector("#music-stream");
            musicStream.classList.add("streaming");
            musicStream.setAttribute("src", playlist[playlistCursor].url);
            musicStream.onloadeddata = function() {
                var song = musicStream.captureStream().getAudioTracks()[0];
                localTracks.push(song);
                // we need to renegotiate
                for( let peerConnection of peerConnections ) {
                    // add the server generated music
                    addTrackToPeerConnectionWithMidMap( peerConnection, song, "server-generated" );
                    createOfferWhenStable( peerConnection.peerConnection, peerConnection.id );
                }
                updatePlaylist();
                musicStream.onended = function() {
                    musicStream.classList.remove("streaming");
                    removeTracksFromPeerConnections( "server-generated", [song] );
                    playlistCursor++;
                    updatePlaylist(); // on the clients
                    playNextVideo();
                }
            }
            musicStream.onerror = function() {
                playNextVideoTimeout = setTimeout(playNextVideo, VIDEO_FETCH_TIMEOUT);
            }
        }
        catch(err) {
            playNextVideoTimeout = setTimeout(playNextVideo, VIDEO_FETCH_TIMEOUT);
        }
    }
    // video not available yet
    else {
        playNextVideoTimeout = setTimeout(playNextVideo, VIDEO_FETCH_TIMEOUT);
    }
}

/**
 * Login with a room code in the field.
 */
function login() {
    document.querySelector("#splash button").onclick = function() {};
    document.querySelector("#error-message").innerHTML = "";
    roomCode = document.querySelector("#code").value;
    socket = io.connect(window.location.protocol+"//"+window.location.hostname);
    socket.on("connect", function() {
        console.log("socket connected");
        if( !isServer ) {
            displayScreencast();
        }
    });
}

/**
 * Display the screencast.
 */
function displayScreencast() {
    if( isServer ) {
        return;
    }

    makeRequest( "GET", "/join", { id: socket.id, roomCode: roomCode }, function() {
        document.querySelector("#splash").classList.add("hidden");
        document.querySelector("#videos").classList.add("visible");
        window.history.pushState({},"","?room_code=" + roomCode);
        drawPlaylist();
        resetCancelStreamingInterval = setInterval( function() {
            makeRequest( "GET", "/reset-cancel", { id: socket.id, roomCode: roomCode } );
        }, RESET_CANCEL_STREAMING_INTERVAL );
        connectToSignalServer(false);
    }, function(data) {
        var errorMessage = "An error has ocurred. Please try again"
        try {
            errorMessage = JSON.parse(data).message;
        }
        catch(err) {}
        document.querySelector("#error-message").innerText = errorMessage;
        document.querySelector("#splash button").onclick = login;
    } );
}


/**
 * Connect to the signal server.
 */
function connectToSignalServer() {

    var event = "connect-screencast-" + (isServer ? "streamer" : "client");
    socket.emit( event, {roomCode: roomCode} );
    socket.off()
    socket.on( 'sdp', handleRemoteSdp );
    socket.on( 'ice', handleRemoteIce );
    socket.on( 'data', handleRemoteData );

    if( isServer ) {
        setUpMusicStream();
        getDisplayMediaSuccess( new MediaStream() );
        //navigator.mediaDevices.getDisplayMedia({"video": { "cursor": "never" }, "audio": true}).then(getDisplayMediaSuccess).catch(errorHandler);
    }
    else {
        var constraints = {
            video: {
                width: { min: 320, ideal: 320 },
                height: { min: 240 },
                frameRate: 30,
                facingMode: "user"
            },
            audio: {
                sampleRate: { ideal: 44000 },
                sampleSize: { ideal: 16 }
            }
        };
        navigator.mediaDevices.getUserMedia(constraints).then(getUserMediaSuccess).catch(
        function(error) {
            // this isn't in GuyStation, but it shouldn't be since we don't fail to get client media...
            clearInterval( resetCancelStreamingInterval );
            errorHandler(error);
        });
    }

}

/**
 * Set the value of the localTracks variable once it is successfully fetched.
 * This should only ever be called from Galleria, since we don't stream the page on the client.
 * @param {Array} stream - The tracks (audio and video).
 */
function getDisplayMediaSuccess(stream) {
    localTracks = [];
    socket.emit("streamer-media-ready", { roomCode: roomCode });
}

/**
 * The user media has been successfully gotten.
 * @param {Array} stream - The tracks (audio and video).
 */
function getUserMediaSuccess(stream) {
    localTracks = stream.getVideoTracks().concat(stream.getAudioTracks());
    // go ahead and display the user
    drawVideos();
    socket.emit("client-media-ready", { roomCode: roomCode });
}

/**
 * Start a connection to the peer.
 * Peer connection should already be defined.
 * This should be initially called by the menuPage (using puppeteer evaluate) after it detects a client connect to it.
 * Once the server is connected to the client, the client will connect to the server automaitcally as seen in the handle functions
 * @param {string} [id] - The id of the peer (this is only relevant for the server).
 */
function startConnectionToPeer( id ) {
    if( !id ) id = "server";
    var peerConnection = new RTCPeerConnection({ iceServers: [{
        urls: "stun:stun.l.google.com:19302"
    }] });
    var peerConnectionObject = {"id": id, "peerConnection": peerConnection, "tracks": [], "midMap": {} }; // tracks are from the peer, mid map are senders to the peer
    peerConnections.push( peerConnectionObject );
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/onicecandidate
    // onicecandidate is not called when you do addIceCandidate. It is called whenever
    // it is deemed necessary that you send your ice candidates to the signal server
    // (usually after you have sent an offer or an answer).
    peerConnection.onicecandidate = function(event) {gotIceCandidate(id, event)};
    peerConnection.oniceconnectionstatechange = function() {handlePotentialDisconnect(id)};
    peerConnection.ontrack = function(event) { gotRemoteTrack(event, id) };
    if( isServer ) {
        for (var i=0; i<localTracks.length; i++) {
            addTrackToPeerConnectionWithMidMap( peerConnectionObject, localTracks[i], getSocketSenderForTrack( localTracks[i] ) );
            // make sure each peer knows about the playlist
            socket.emit( "data", { id: peerConnectionObject.id, data: {"playlist": playlist, "playlistCursor": playlistCursor}, roomCode: roomCode } );
        }
        // the server creates the offer
        peerConnection.createOffer({offerToReceiveVideo: true, offerToReceiveAudio: true}).then(function(data) {createdDescription(id, data)}).catch(errorHandler);
    }
    else {
        for (var i=0; i<localTracks.length; i++) {
            peerConnection.addTrack(localTracks[i]);
        }
    }
}

/**
 * Get the socket that a track came to the server from.
 * @param {MediaStreamTrack} track - The track.
 * @returns {string} The id of the socket or null if there is not one.
 */
function getSocketSenderForTrack( track ) {
    var match = peerConnections.filter( el => el.tracks.includes(track) ); // remember that tracks for a peerConnection is that tracks coming from that peerConnection
    if( match.length ) return match[0].id;
    if( localTracks.includes(track) ) return "server-generated";
    return null;
}

/**
 * Handle a potential disconnect.
 * @param {string} [id] - The id of the peer that we lost connection to.
 */
function handlePotentialDisconnect( id ) {
    var peerConnection = peerConnections.filter(el => el.id==id)[0].peerConnection;
    if( peerConnection.iceConnectionState == "disconnected" ) {
        stopConnectionToPeer(id, isServer ? true : false); // note we pretend we are not the streamer even if we are here.
        // this will close the connection, but then it will call all the server functions we need to allow for
        // another connection to take place. Then, the server will try to stop the connection on the menuPage, but
        // it will not pass any of the checks, since peerConnection will already be null as will localStream
    }
}

/**
 * Stop the peer connection.
 * Since the connection will always be closed from the client, if this is the client
 * this will tell the server to stop too once it has closed.
 * @param {string} [id] - The id of the peer to stop the connection to.
 * @param {boolean} [useIdAsSocketId] - send the id as the socket id - this is what the server will read as the id to stop the connection to. So when we are pretending to not be the server, we should set this to the peer id. When are the client, it should be our socket id.
 */
function stopConnectionToPeer( id, useIdAsSocketId ) {
    // the server will see what tracks are going to be disabled by taking the difference between the peerConnections tracks and localStreams
    var tracksComingFromPeer = [];
    if( isServer ) { // we need to do this once no matter if it is the time called by the server of the client.
        var peerConnectionObject = peerConnections.filter(el => el.id==id)[0];
        if( peerConnectionObject ) {
            tracksComingFromPeer = peerConnectionObject.tracks;
        }
    }
    // we'll throw an error here if the stream has already been stopped/never started
    if( peerConnections.length ) { // It's ok if this throws an error. It means we already ran this function or reset cancel called this and we never had a peer connection.
        var peerConnection = peerConnections.filter(el => el.id==id)[0].peerConnection;
        peerConnection.close();
        peerConnections = peerConnections.filter(el => el.id != id);
    }
    if( !isServer || useIdAsSocketId ) {
        var stopLettingServerKnowWeExist = function() { clearInterval(resetCancelStreamingInterval); };
        // stop letting the server know we exist once it stops expecting us
        // this will only stop the server if this is the last connection
        // if this request fails, we'll at least stop the heartbeat, and the server will then remove us on its own.
        makeRequest("GET", "/stop", {id: useIdAsSocketId ? id : socket.id, roomCode: roomCode}, stopLettingServerKnowWeExist, stopLettingServerKnowWeExist );
    }
    // the server will update the streams
    if( isServer && tracksComingFromPeer.length ) {
        removeTracksFromPeerConnections( id, tracksComingFromPeer )
    }
}
 
/**
 * Handle an offer/answer in WebRTC protocol.
 * Note how this expects data modified by the server to have some identification metadata.
 * @param {Object} data - A peer ID and some sdp data.
 * @param {string} data.id - The peer id.
 * @param {Object} data.sdp - The data associated with the offer/answer.
 */
function handleRemoteSdp(data) {
    // this is to create the peer connection on the client (an offer has been received from Galleria)
    if(!peerConnections.length) startConnectionToPeer();

    var peerConnection = peerConnections.filter( (el) => el.id == data.id )[0].peerConnection;

    // we need to reoffer here if the signalising state is stable.
    // Set the information about the remote peer set in the offer/answer
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(function() {
        // If this was an offer sent from Galleria, respond to the client
        if( data.sdp.type == "offer" ) {
            // Send an answer
            var curData = data;

            // duplicates will cause a harmless error.
            peerConnection.createAnswer().then(function(data) {createdDescription(curData.id, data)}).catch(errorHandler);
        }
    });
}

/**
 * Handle receiving information about and ICE candidate in the WebRTC protocol.
 * Note: this can happen simulatneously with the offer/call although theoretically happens after.
 * Note how this expects data modified by the server to have some identification metadata.
 * @param {Object} data - A peer ID and some ice data.
 * @param {string} data.id - The peer id.
 * @param {Object} data.sdp - The data associated with the ice candidates.
 */
function handleRemoteIce(data) {
    // this is to create the peer connection on the client (an offer has been received from guystation)
    if(!peerConnections.length) startConnectionToPeer();

    var peerConnection = peerConnections.filter( (el) => el.id == data.id )[0].peerConnection;

    // Set the information about the remote peer set in the offer/answer
    peerConnection.addIceCandidate(new RTCIceCandidate(data.ice)).catch(errorHandler);
}

/**
 * Handle remote arbitrary data.
 * @param {Object} data 
 */
function handleRemoteData(data) {
    // midmap update
    if( data.data.midMap ) {
        if( data.data.counter > remoteMidMapCounter ) {
            // this is just to clean up tracks in peer connection.
            if( data.data.type == "delete" ) {
                // get the keys of the map
                var midKeys = Object.keys(data.data.midMap);
                var newTracks = [];
                for(var i=0; i<midKeys.length; i++) {
                    // get the values (the mid pairs)
                    var midValues = data.data.midMap[midKeys[i]];
                    for(var j=0;j<midValues.length; j++) {
                        var track = midToTrackMap[ midValues[j] ];
                        if( peerConnections[0].tracks.includes( track ) ) {
                            newTracks.push(track);
                        }
                    }
                }
                peerConnections[0].tracks = newTracks;
            }
            // end nice cleanup tracks of peerconnection object
            remoteMidMap = data.data.midMap;
            drawVideos();
            remoteMidMapCounter = data.data.counter;
        }
    }
    else if (data.data.playlist) {
        playlist = data.data.playlist;
        playlistCursor = data.data.playlistCursor;
        drawPlaylist();
    }
}

/**
 * Handle when we have successfully determined one of our OWN ice candidates.
 * @param {string} id - The id of the peer.
 * @param {Event} event - The event that triggers this handler.
 */
function gotIceCandidate(id, event) {
    if(event.candidate != null) {
        // alert the signal server about this ice candidate
        socket.emit("ice", {id: id, candidate: event.candidate, roomCode: roomCode});
    }
}

/**
 * Handle when the local description has been successfully determined.
 * @param {string} id - The id of the peer.
 * @param {Object} description - A generated local description necessary to include in an offer/answer.
 */
function createdDescription(id, description) {
    var peerConnection = peerConnections.filter(el => el.id==id)[0].peerConnection;
    peerConnection.setLocalDescription(description).then(function() {
        // apparently it's ok if we fail to set local description which is the error that is thrown when sending another offer.
        socket.emit("sdp", {id: id, description: peerConnection.localDescription, roomCode: roomCode});
    }).catch(errorHandler);
}

/**
 * Draw the current videos.
 * This will blank out the arrays indicating we've done a draw.
 * We only do one draw per offer.
 */
function drawVideos() {
    // var videosElement = document.querySelector("#videos");
    // videosElement.innerHTML = "";

    // update remote tracks.
    var remoteTrackMap = {};
    var mapKeys = Object.keys(remoteMidMap);
    try {
        for( var i=0; i<mapKeys.length; i++ ) {
            var midPair = remoteMidMap[mapKeys[i]];
            remoteTrackMap[mapKeys[i]] = midPair.map( el => midToTrackMap[el] ).filter(el => el ? true : false);
        }
    }
    catch(err) { console.log(err); }

    // remove the videos that are no longer shown
    var allVideos = document.querySelectorAll("video:not(#video-user-media)");
    for( var i=0; i<allVideos.length; i++ ) {
        var curId = allVideos[i].getAttribute("id").replace("video-","");
        if( !mapKeys.includes(decodeURIComponent(curId)) ) {
            allVideos[i].parentNode.removeChild(allVideos[i]);
            if( curId == "server-generated" ) {
                var controls = document.querySelector("#video-controls");
                if( controls ) {
                    controls.parentNode.removeChild(controls);
                }
            }
        }
    }

    var numTracks = mapKeys.length+1; // +1 for the local track
    if( mapKeys.includes("server-generated") ) {
        numTracks -= 1; // The music doesn't tile.
        document.querySelector("#videos").classList.add("music-visible");
    }
    else {
        document.querySelector("#videos").classList.remove("music-visible");
    }
    console.log(numTracks);

    var tiles = Math.ceil(Math.sqrt(numTracks));
    var percent = Math.floor(100/tiles);
    var heightTiles = tiles;
    // if we aren't going to make our full height of the tile x tile grid, then expand all the tiles into the extra space heightwise
    if( Math.ceil(numTracks*percent/100) < tiles ) {
        heightTiles -= 1;
    }
    var heightPercent = Math.floor(100/heightTiles);

    // we'll expand the height of some of them as necessary too
    var expandedPercent = percent;
    var colsThatGetExpandedHeight = numTracks % tiles;
    if( colsThatGetExpandedHeight ) colsThatGetExpandedHeight = tiles - colsThatGetExpandedHeight;
    if( tiles > 1 ) {
        expandedPercent = Math.floor(100/(heightTiles-1)); // we can go so far as to expand tiles even when we've already expanded all of them (think last column of 5 entries - 100% height is needed)
    }

    createVideoElement([localTracks[0]], 0, colsThatGetExpandedHeight, tiles, percent, heightTiles, expandedPercent, heightPercent, "user-media");
    var index = 0;
    for( var i=0; i<mapKeys.length; i++ ) {
        if( mapKeys[i] == "server-generated" ) index --; // treat the server generated music like it is not there
        createVideoElement(remoteTrackMap[mapKeys[i]], index+1, colsThatGetExpandedHeight, tiles, percent, heightTiles, expandedPercent, heightPercent, mapKeys[i]);
        index ++;
    }
}

/**
 * Create a video element.
 * @param {Array.<MediaStreamTrack>} tracks - The tracks that belong to this video.
 * @param {number} index - The current video number.
 * @param {number} colsThatGetExpandedHeight - The number of columns that expand their height due do having remaining space.
 * @param {number} tiles - The number of tiles the grid technically is (2x2, 3x3, 4x4, etc.)
 * @param {number} percent - The width (and maybe height) of the tiles.
 * @param {number} heightTiles - The grid size we should pretend there is for height. So for 6 videos, we might give each video a 50% height as we would in a 2x2 grid (this parameter would be 2); 
 * @param {number} expandedPercent - The size of the tiles that get to expand. These are tiles that even after heightTiles there might be some extra room to fill. Think of the last column of a 5 video chat. We'd have a 3x3 grid, but that column would get 100% height.
 * @param {number} heightPercent - The percent of the height tiles.
 * @param {string} id - The id of the video.
 */
function createVideoElement(tracks, index, colsThatGetExpandedHeight, tiles, percent, heightTiles, expandedPercent, heightPercent, id) {
    var videosElement = document.querySelector("#videos");
    var col = Math.floor(index*(heightPercent+1)/100); // starts at 0
    var video = document.querySelector("#video-" + encodeURIComponent(id));
    var createdVideo = false;
    if( !video ) {
        createdVideo = true;
        var video = document.createElement("video");
        video.setAttribute("playsinline", "true");
        video.setAttribute("autoplay", true);
        video.setAttribute("id", "video-" + encodeURIComponent(id));
        if( id == "server-generated" ) {
            //video.setAttribute("controls", true);
            video.volume = musicVolume;
            document.body.appendChild(video); // the music is seperate
            createVideoControls();
        }
        else {
            videosElement.appendChild(video);
        }
    }
    if( id == "server-generated" || (id =="user-media" && createdVideo) || (video.captureStream().getTracks().length < 2 && tracks.length == 2) ) { // only update the streams if we don't have audio and video yet. kills 2 birds with one stone. always update the audio stream (since it gets updated - server-generated id gets different tracks) and then allow updates if we don't ahve all the tracks for a stream yet. we neever update peoples streams.
        var stream = new MediaStream();
        for( var i=0; i< tracks.length; i++ ) {
            stream.addTrack(tracks[i]);
        }
        video.srcObject = stream;
    }
    
    if( id != "server-generated" ) video.setAttribute("style","height:"+(col >= (heightTiles - colsThatGetExpandedHeight + (tiles-heightTiles)) ? expandedPercent : heightPercent)+"%;"+"width:"+percent+"%;");
}

/**
 * Create video controls (for the music).
 */
function createVideoControls() {
    var videoControls = document.createElement("div");
    videoControls.setAttribute("id", "video-controls");

    var sliderLabel = document.createElement("label");
    sliderLabel.innerText = "Music Volume: ";
    videoControls.appendChild(sliderLabel);

    var volumeSlider = document.createElement("input");
    volumeSlider.setAttribute("type", "range");
    volumeSlider.setAttribute("min", 0);
    volumeSlider.setAttribute("max", 100);
    volumeSlider.value = musicVolume * 100;
    volumeSlider.oninput = function() {
        var music = document.querySelector("#video-server-generated");
        musicVolume = this.value/100;
        if( music ) {
            music.volume = musicVolume;
        }
    };
    sliderLabel.appendChild(volumeSlider);

    document.body.appendChild(videoControls);
}

/**
 * Handler for when a remote track has been found.
 * @param {Event} event - The event that triggered the tracl.
 * @param {string} [id] - The id of the peer connection.
 */
function gotRemoteTrack(event, id) {
    if( !isServer ) {
        peerConnections[0].tracks.push(event.track);
        midToTrackMap[event.transceiver.mid] = event.track; // now we can look up a track by the mid
        drawVideos();
    }
    else {
        localTracks.push(event.track);
        // update the list of tracks coming from the peer connection. There's no getTracks method, so this is easiest.
        var tLength = 0;
        for( var i=0; i<peerConnections.length; i++ ) {
            if( peerConnections[i].peerConnection == event.srcElement ) {
                peerConnections[i].tracks.push(event.track);
                tLength = peerConnections[i].tracks.length;
            }
        }

        // we need to add videos on the server to get the audio to work
        // I don't know why.
        var videosElement = document.querySelector("#videos");
        videosElement.innerHTML = "";
        var video = document.createElement("video");
        video.setAttribute("playsinline", "true");
        video.setAttribute("autoplay", true);
        var stream = new MediaStream();
        stream.addTrack(event.track);
        video.srcObject = stream;
        videosElement.appendChild(video);
        setTimeout( function() {
            videosElement.innerHTML = "";
        }, 500);

        // we need to renegotiate
        for( let peerConnection of peerConnections ) {
            if( peerConnection.id != id ) {
                addTrackToPeerConnectionWithMidMap( peerConnection, event.track, id, true );
                if( tLength == 2 || id == "server-generated" ) {
                    // good time to send the offer. Note, we need audio and video...
                    // If you do this right away, we never get the mid... apparently the mid is null until negotiation finishes. I guess we just have to wait a sec.
                    // so instead, I'm just going to do it for video tracks. I think that's the problem. We're sending an offer for each track.
                    //setTimeout( function() {
                    //}, 10);
                    // we still get an error if adding a track right after say joining. this is due to two very close offers.
                    createOfferWhenStable(peerConnection.peerConnection, peerConnection.id);
                }
            }
        }
    }
}

/**
 * Create a renegotiation offer when we are stable (don't want to renegotiate in the middle of negotiation)
 * @param {RTCPeerConnection} peerConnection - The peer connection. 
 * @param {string} id - The socket id of the peer connection.
 */
function createOfferWhenStable(peerConnection, id) {
    var offerInterval = setInterval( function() {
        if( peerConnection.signalingState != "stable" ) return;
        clearInterval( offerInterval );
        peerConnection.createOffer({offerToReceiveVideo: true, offerToReceiveAudio: true}).then(function(data) {createdDescription(id, data)}).catch(errorHandler);
    }, 10 );
}

/**
 * Add a track to a peer connection properly alerting the peer of the new MID. These are tracks going TO the peerConection.
 * @param {Object} peerConnectionObject - The peerConnection Object.
 * @param {MediaStreamTrack} track - The track to add.
 * @param {number} id - The id of the socket the track is coming to the server from. Serves as the keys for the MIDMAP pairs.
 * @param {boolean} sendOffer - True if we should renogiate with an offer.
 */
function addTrackToPeerConnectionWithMidMap(peerConnectionObject, track, id, sendOffer) {
    var sender = peerConnectionObject.peerConnection.addTrack(track); // each track has a unique sender
    var transceiver = peerConnectionObject.peerConnection.getTransceivers().filter(el => el.sender == sender)[0]; // and thus a transceiver (muted response until we have that many tracks fromt he peer)
    // sometimes mid is not immediately available
    var updateMidMap = setInterval( function() {
        if( !transceiver.mid ) return;

        clearInterval(updateMidMap);
        if( !peerConnectionObject.midMap[id] ) {
            peerConnectionObject.midMap[id] = [];
        }
        peerConnectionObject.midMap[id].push( transceiver.mid );

        // let the peer know about the midMap, so they can peice together the streams
        socket.emit( "data", { id: peerConnectionObject.id, data: {"midMap": peerConnectionObject.midMap, "counter": midMapCounter}, roomCode: roomCode } );
        midMapCounter ++; // so the client knows the order.
    }, 10 );

    // so the mid are the ids of each stream being SENT to a peer connection.
    // you need to get all the transceivers for the peer connection. These transcievers will have mid - media id.
    // adding a track returns an sdpsender which is connceted to a sole transceiver.
    // This mid is what is available in the event.transciever object sent to the client.
    // this is how you can match items on the sender with the receiver. this mid.
    // so you'll have to keep track of the mids like you do the tracks I guess.
    // send the mids to the client in data.
    // let the clients then create streams, pairing together the streams that have the same mid.
    // alternively you can add a stream parameter to the track which will result in that stream id being available to the remote peer
    // at least that's what it claims here: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addTrack, but it seems like that isn't true.
}

/**
 * Remove tracks coming from a peer from all peer connections and take care of MIDMAPS.
 * @param {string} id - The id of the peer to remove the track from.
 * @param {Array<MediaStreamTracks>} tracks - The tracks to remove.
 */
function removeTracksFromPeerConnections( id, tracks ) {
    // remove the tracks coming from the dead and then do renogeotiation
    for( var i=0; i<tracks.length; i++ ) {
        removeTrackFromList( localTracks, tracks[i] );
    }
    for( let peerConnectionObject of peerConnections ) {
        // remove all tracks from the connection
        var transceivers = peerConnectionObject.peerConnection.getTransceivers();
        for( var j=0; j<transceivers.length; j++ ) {
            if(tracks.includes(transceivers[j].sender.track)) {
                peerConnectionObject.peerConnection.removeTrack( transceivers[j].sender );
            }
        }
        delete peerConnectionObject.midMap[ id ];
        // update midMaps on the clients.
        socket.emit( "data", { id: peerConnectionObject.id, data: {"midMap": peerConnectionObject.midMap, "counter": midMapCounter, "type": "delete"}, roomCode: roomCode } );
        midMapCounter ++; // so the client knows the order.
        createOfferWhenStable( peerConnectionObject.peerConnection, peerConnectionObject.id );
    }
}

/**
 * The error handler for Screencast.
 * @param {Error} error - The error.
 */
function errorHandler(error) {
    console.log(error);
}

/**
 * Make a request.
 * @param {string} type - "GET" or "POST".
 * @param {string} url - The url to make the request to.
 * @param {object} parameters - An object with keys being parameter keys and values being parameter values to send with the request.
 * @param {function} callback - Callback function to run upon request completion.
 * @param {boolean} useFormData - True if we should use form data instead of json.
 */
function makeRequest(type, url, parameters, callback, errorCallback, useFormData) {
    var parameterKeys = Object.keys(parameters);

    url = window.location.protocol+"//" + window.location.hostname + url;
    if( type == "GET" && parameterKeys.length ) {
        var parameterArray = [];
        for( var i=0; i<parameterKeys.length; i++ ) {
            parameterArray.push( parameterKeys[i] + "=" + parameters[parameterKeys[i]] );
        }
        url = url + "?" + parameterArray.join("&");
    }
   
    var xhttp = new XMLHttpRequest();
    xhttp.open(type, url, true);

    if( type != "GET" && parameterKeys.length ) {
        if( !useFormData ) {
            xhttp.setRequestHeader("Content-type", "application/json");
        }
    } 

    xhttp.onreadystatechange = function() {
        if( this.readyState == 4 ) {
            if( this.status == 200 ) {
                if( callback ) { callback(this.responseText); }
            }
            else {
                if( errorCallback ) { errorCallback(this.responseText); }
            }
        }
    }    
    if( type != "GET" && Object.keys(parameters).length ) {
        var sendParameters;
        if( useFormData ) {
            sendParameters = new FormData();
            for ( var key in parameters ) {
                sendParameters.append(key, parameters[key]);
            }
        }
        else {
            sendParameters = JSON.stringify(parameters);
        }
        xhttp.send( sendParameters );
    }
    else {
        xhttp.send();
    }
}
