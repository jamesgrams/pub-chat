/**
* each client connects to the server and shares their video
* the server then shares back his screen with the clients
* we already have the server streaming to the clients.
* what we need is the clients streaming to the server.
* we can accept new clients at will who can all see the server.
* what we need to add is a client-media-ready that tells
* the server to start the connection to the clients.
*/

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const youtubedl = require('youtube-dl');

const SUCCESS = "success";
const FAILURE = "failure";
const HTTP_SEMANTIC_ERROR = 422;
const HTTP_OK = 200;
const HTTP_TEMPORARILY_UNAVAILABLE = 503;
const PORT = process.env.PORT || 80;
const ASSETS_DIR = "assets";
const TEMP_DIR = "tmp";
const ENTIRE_SCREEN = "Entire screen";
const LOCALHOST = "http://localhost";
const IS_SERVER_PARAM = "is_server";
const ROOM_CODE_PARAM = "room_code";
const INDEX_PAGE = "index.html";
const STREAMING_HEARTBEAT_TIME = 20000; // after 20 seconds of no response from the client, we will force close the stream
const ROOMS_ALLOWED = 2;
const ERROR_MESSAGES = {
    "genericError": "An error has ocurred.",
    "menuPageClosed": "Room unavailable. Please try a different one.",
    "clientAndServerAreNotBothConnected": "Client and server are not both connected.",
    "screencastNotStarted": "Screencast not started.",
    "invalidRequest": "Invalid Request.",
    "locked": "The server is busy. Please wait a second.",
    "tooManyRooms": "Too many rooms are being used at the moment. Please try again later."
}

let browser;
let menuPages = {};
let playlists = {};
let requestLocked = false;

/**************** Express ****************/

// Delete everything left over in the tmp directory
let tmpPath = ASSETS_DIR + "/" + TEMP_DIR;
if( fs.existsSync(tmpPath) ) {
    let tmpFiles = fs.readdirSync(tmpPath);
    for( let file of tmpFiles ) {
        fs.unlinkSync(ASSETS_DIR + "/" + TEMP_DIR + "/" + file);
    }
}
else {
    fs.mkdirSync(tmpPath);
}

const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

app.use( express.json({limit: '20000mb'}) );

app.use( "/"+ASSETS_DIR+"/", express.static(ASSETS_DIR) );

// Middleware to allow cors from any origin
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header('Access-Control-Allow-Methods', 'PUT, POST, GET, DELETE, OPTIONS, PATCH');
    next();
});

// Endpoint to serve the basic HTML needed to run this app
app.get("/", async function(request, response) {
    console.log("app serving / (GET)");
    request.url = "/"+ASSETS_DIR+"/"+INDEX_PAGE;
    app.handle(request, response);
});

// Connect the menu page to the signal server
app.get("/join", async function(request, response) {
    try {
        if( !requestLocked ) {
            console.log("app serving /join");
            requestLocked = true;
            // create a host page if needed
            // if there is no room code, the connect screencast will throw an arrow.
            // should be null..
            if( request.query.roomCode && (!menuPages[request.query.roomCode] || menuPages[request.query.roomCode].isClosed()) ) {
                let errorAdding = await addMenuPage(request.query.roomCode);
                if( errorAdding ) {
                    requestLocked = false;
                    writeActionResponse( response, errorAdding );
                }
            }
            let errorMessage = await connectScreencast( request.query.id, request.query.roomCode );
            requestLocked = false;
            writeActionResponse( response, errorMessage );
        }
        else {
            writeActionResponse( response, ERROR_MESSAGES.locked );
        }
    }
    catch(err) {
        console.log(err);
        writeActionResponse( response, ERROR_MESSAGES.genericError );
    }
});

// Connect the menu page to the signal server
app.get("/stop", async function(request, response) {
    console.log("app serving /stop");
    try {
        // don't allow screencast to start while we're trying to do something else
        let errorMessage = await stopScreencast( request.query.id );
        writeActionResponse( response, errorMessage );
    }
    catch(err) {
        console.log(err);
        writeActionResponse( response, ERROR_MESSAGES.genericError );
    }
});

// Reset screencast cancel timeout
app.get("/reset-cancel", async function(request, response) {
    //console.log("app serving /reset-cancel");
    try {
        let errorMessage = resetScreencastTimeout( request.query.id, request.query.roomCode );
        writeActionResponse( response, errorMessage );
    }
    catch(err) {
        console.log(err);
        writeActionResponse( response, ERROR_MESSAGES.genericError );
    }
});

// add a link to the playlist
app.post("/playlist", async function(request, response) {
    console.log("app serving /playlist");
    try {
        let errorMessage = addToPlaylist(request.body.url, request.body.roomCode);
        writeActionResponse( response, errorMessage );
    }
    catch(err) {
        console.log(err);
        writeActionResponse( response, ERROR_MESSAGES.genericError );
    }
});

// change the playlist counter to basically change the song
app.post("/playlist-cursor", async function(request, response) {
    console.log("app serving /playlist-cursor");
    try {
        let errorMessage = changePlaylistCursor(request.body.cursor, request.body.roomCode);
        writeActionResponse( response, errorMessage );
    }
    catch(err) {
        console.log(err);
        writeActionResponse( response, ERROR_MESSAGES.genericError );
    }
});

// START PROGRAM (Launch Browser and Listen)
server.listen(PORT);

/**************** Functions ****************/

/**
 * Launch Browser.
 */
async function launchBrowser() {
    let options = {
        headless: true,
        defaultViewport: null,
        args: [
            /*'--start-fullscreen',*/
            '--mute-audio',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            `--auto-select-desktop-capture-source=${ENTIRE_SCREEN}` // this has to be like this otherwise the launcher will not read the argument. It has to do with node.js processes and how they handle quotes with shell=true. 
        ]
    };
    browser = await puppeteer.launch(options);
}

/**
 * Add a menu page
 * @param {string} roomCode - The string of the room code.
 * @returns {(boolean|string)} - An error message if there is one or false if not.
 */
async function addMenuPage( roomCode ) {

    let totalRooms = Object.keys(menuPages).filter( el => menuPages[el] ).length;
    if( totalRooms >= ROOMS_ALLOWED ) return ERROR_MESSAGES.tooManyRooms;

    let menuPage;
    if( !browser || !browser.isConnected() ) {
        await launchBrowser();
        let pages = await browser.pages();
        menuPage = await pages[0];
    }
    else {
        menuPage = await browser.newPage();
    }
    menuPage.on("pageerror", function (error) {
        console.log(error);
    })
    menuPage.on("requestfailed", function (request) {
        console.log("request failed: " + request.url());
    })
    let menuUrl = process.env.MENU_URL ? process.env.MENU_URL : LOCALHOST + ":" + PORT;
    await menuPage.goto(menuUrl + "?" + IS_SERVER_PARAM + "&" + ROOM_CODE_PARAM + "=" + encodeURIComponent(roomCode));
    menuPages[roomCode] = menuPage;
    serverSocketIds[roomCode] = null;
    clientSocketIds[roomCode] = [];
    startedClientIds[roomCode] = [];
    clientMediaReady[roomCode] = false;
    streamerMediaReady[roomCode] = false;

    return false;
}

/**
 * Write a standard response for when an action is taken.
 * @param {Response} response - The response object.
 * @param {string} errorMessage - The error message from running the code.
 */
function writeActionResponse( response, errorMessage ) {
    if( errorMessage ) {
        writeResponse( response, FAILURE, { "message": errorMessage }, HTTP_SEMANTIC_ERROR );
    }
    else {
        writeResponse( response, SUCCESS );
    }
}

/**
 * Send a response to the user.
 * @param {Response} response - The response object.
 * @param {string} status - The status of the request.
 * @param {Object} object - An object containing values to include in the response.
 * @param {number} code - The HTTP response code (defaults to 200).
 * @param {string} contentType - The content type of the response (defaults to application/json).
 */
function writeResponse( response, status, object, code, contentType ) {
    if( !code ) { code = HTTP_OK; }
    if( !contentType ) { contentType = "application/json"; }
    if( !object ) { object = {}; }
    response.writeHead(code, {'Content-Type': 'application/json'});
    
    let responseObject = Object.assign( {status:status}, object );
    response.end(JSON.stringify(responseObject));
}

/**
 * Change the playlist cursor - change what song is playing.
 * @param {number} cursor - The index of the song to play.
 * @param {string} roomCode - The room code of the meeting.
 */
function changePlaylistCursor(cursor, roomCode) {
    if( isNaN(cursor) || !roomCode || !menuPages[roomCode] ) return ERROR_MESSAGES.invalidRequest;

    menuPages[roomCode].evaluate( c => changeVideo(c), cursor );
}

/**
 * Add a YouTube video to the playlist for a room.
 * @param {string} url - The url of the YouTube video. 
 * @param {string} roomCode - The room for the playlist.
 * @returns {(boolean|string)} An error message if there is one or false if there is not.
 */
function addToPlaylist( url, roomCode ) {
    if( !url || !roomCode || !menuPages[roomCode] ) return ERROR_MESSAGES.invalidRequest;

    var file = getFileFromUrl(url, roomCode);
    if( !file ) return ERROR_MESSAGES.invalidRequest;

    if( !playlists[roomCode] ) playlists[roomCode] = [];
    var newSong = { "youtubeUrl": url };
    var errorFound = false;
    
    var video = youtubedl(url, ["--format=bestaudio[ext=webm]"]);
    var ws = fs.createWriteStream(file);
    video.pipe(ws);
    video.on("error", function() {
        console.log("error getting video");
        errorFound = true;
    });
    video.on('info', function(info) {
        newSong.name = info.fulltitle;
    });
    ws.on('finish', function() {
        console.log("dl finished");

        var waitForInfo = setInterval( function() {
            if( !newSong.name && !errorFound ) return;
            clearInterval( waitForInfo );
            if( errorFound ) return; // not sure how to alert this error to the client

            playlists[roomCode].push( newSong ); // now it's safe to record on the playlist
            // The playlist on the client will just have the files and names, not the original youtube link
            menuPages[roomCode].evaluate( pl => updatePlaylist(pl), playlists[roomCode].map(function(el) { return {"url": "/" + getFileFromUrl(el.youtubeUrl, roomCode), "name": el.name } }) );
        }, 100 );
    });

    return false;
}

/**
 * Get the filename for a YouTube video.
 * @param {string} url - The url of the YouTube video. 
 * @param {string} roomCode - The room for the playlist.
 * @returns {(boolean|string)} The filepath for the YouTube video or false if we can't get it.
 */
function getFileFromUrl( url, roomCode ) {
    var string = url.match(/[\?&]v=([^&]*)/);
    if( !string ) return false;
    return ASSETS_DIR + "/" + TEMP_DIR + "/" + roomCode + "--" + string[1] + ".webm";
}

// Signal server section
let streamerMediaReady = {};
let clientMediaReady = {};
let SERVER_ID = "server";
let serverSocketIds = {};
let clientSocketIds = {}; // Arrays of clients keyed by room code
let startedClientIds = {};
let cancelStreamingTimeouts = [];
io.on('connection', function(socket) {
    socket.on("connect-screencast-streamer", function(message) {
        try {
            if( !serverSocketIds[message.roomCode] ) { // only one server allowed per room
                console.log("screencast streamer connected");
                serverSocketIds[message.roomCode] = socket.id;
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
    // we have to wait for the following two events until we are ready
    // to start streaming
    socket.on("streamer-media-ready", function(message) {
        try {
            console.log("screencast media ready");
            streamerMediaReady[message.roomCode] = true;
            if( clientMediaReady[message.roomCode] ) {
                for( let clientSocketId of clientSocketIds[message.roomCode].filter( el => !startedClientIds[message.roomCode].includes(el) ) ) {
                    startScreencast(clientSocketId, message.roomCode);
                }
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
    socket.on("connect-screencast-client", function(message) {
        try {
            if( clientSocketIds[message.roomCode].indexOf(socket.id) == -1 ) {
                console.log("screencast client connected");
                clientSocketIds[message.roomCode].push(socket.id);
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
    socket.on("client-media-ready", function(message) {
        try {
            console.log("screencast client media ready");
            clientMediaReady[message.roomCode] = true;
            if( streamerMediaReady[message.roomCode] ) {
                for( let clientSocketId of clientSocketIds[message.roomCode].filter( el => !startedClientIds[message.roomCode].includes(el) ) ) {
                    startScreencast(clientSocketId, message.roomCode);
                }
            }
        }
        catch(err) {
            console.log(err);
        }
    });
    socket.on("sdp", function(message) {
        try {
            if( socket.id == serverSocketIds[message.roomCode] ) {
                io.to(message.id).emit("sdp", { "id": SERVER_ID, "sdp": message.description });
            }
            else if( clientSocketIds[message.roomCode].includes(socket.id) ) {
                io.to(serverSocketIds[message.roomCode]).emit("sdp", { "id": socket.id, "sdp": message.description } );
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
    socket.on("ice", function(message) {
        try {
            if( socket.id == serverSocketIds[message.roomCode] ) {
                io.to(message.id).emit("ice", { "id": SERVER_ID, "ice": message.candidate });
            }
            else if( clientSocketIds[message.roomCode].includes(socket.id) ) {
                io.to(serverSocketIds[message.roomCode]).emit("ice", { "id": socket.id, "ice": message.candidate } );
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
    socket.on("data", function(message) {
        try {
            if( socket.id == serverSocketIds[message.roomCode] ) {
                io.to(message.id).emit("data", { "id": SERVER_ID, "data": message.data });
            }
            else if( clientSocketIds[message.roomCode].includes(socket.id) ) {
                io.to(serverSocketIds[message.roomCode]).emit("data", { "id": socket.id, "data": message.data } );
            }
        }
        catch(err) {
            console.log(err);
        }
    } );
} );

/**
 * Reset the streaming timeout heartbeat time.
 * @param {string} [id] - The id of the client.
 * @param {string} roomCode - The room code the client is in.
 * @returns {boolean} Returns false.
 */
function resetScreencastTimeout( id, roomCode ) {
    clearTimeout(cancelStreamingTimeouts[id]);
    cancelStreamingTimeouts[id] = setTimeout( function() {
        if( serverSocketIds[roomCode] ) { 
            stopScreencast(id, roomCode); } 
        },
    STREAMING_HEARTBEAT_TIME );
    return false;
}

/**
 * Connect the server page to the signal server.
 * @param {string} id - The id of the socket asking the menuPage to connect.
 * @param {string} roomCode - The room that is joining.
 * @returns {Promise<(boolean|string)>} An error message if there is one or false if there is not.
 */
async function connectScreencast( id, roomCode ) {
    if( !menuPages[roomCode] || menuPages[roomCode].isClosed() ) {
        return Promise.resolve(ERROR_MESSAGES.menuPageClosed);
    }

    resetScreencastTimeout( id, roomCode ); // add to the screencast timeouts
    // this is extra security beyond oniceconnectionstatechange in case the connection never happens
    // so it never disconnects

    // do not connect again if we are already connected
    if( serverSocketIds[roomCode] ) {
        return false;
    }
    // focus on guy station
    await menuPages[roomCode].evaluate( () => connectToSignalServer(true) );    

    return Promise.resolve(false);
}

/**
 * Start the menuPage's screencast.
 * @param {string} id - The socket id of the client to start screencasting to.
 * @param {string} roomCode - The room that is joining.
 * @returns {Promise<(boolean|string)>} An error message if there is one or false if there is not.
 */
async function startScreencast( id, roomCode ) {
    if( !menuPages[roomCode] || menuPages[roomCode].isClosed() ) {
        return Promise.resolve(ERROR_MESSAGES.menuPageClosed);
    }
    if( !serverSocketIds[roomCode] || !clientSocketIds[roomCode].length ) {
        return Promise.resolve(ERROR_MESSAGES.clientAndServerAreNotBothConnected );
    }
    if( startedClientIds[roomCode].includes( id ) ) {
        return Promise.resolve(ERROR_MESSAGES.screencastAlreadyStarted);
    }
    startedClientIds[roomCode].push(id);
    await menuPages[roomCode].evaluate( (id) => startConnectionToPeer(id), id );

    return Promise.resolve(false);
}

/**
 * Stop a connection on the menu page.
 * @param {string} id - The id of the client that no longer needs the stream.
 * @param {string} roomCode - The room that is joining.
 * @returns {Promise<(boolean|string)>} An error message if there is one or false if there is not.
 */
async function stopScreencast(id, roomCode) {
    if( !menuPages[roomCode] || menuPages[roomCode].isClosed() ) {
        return Promise.resolve(ERROR_MESSAGES.menuPageClosed);
    }
    if( !serverSocketIds[roomCode] || !clientSocketIds[roomCode].length ) {
        return Promise.resolve(ERROR_MESSAGES.clientAndServerAreNotBothConnected );
    }
    if( !clientSocketIds[roomCode].length ) {
        return Promise.resolve(ERROR_MESSAGES.screencastNotStarted);
    }

    console.log( "stopping: " + id );

    clientSocketIds[roomCode] = clientSocketIds[roomCode].filter( el => el != id );
    startedClientIds[roomCode] = startedClientIds[roomCode].filter( el => el != id );

    try {
        await menuPages[roomCode].evaluate( (id) => stopConnectionToPeer(id), id ); // the server is stopping it, so we're certainly not going to have the menuPage call out to the server
    }
    catch(err) { console.log("connection already stopped"); /* this is OK, it just means the connection has already been stopped. The menu page could have stopped it, and then called the endpoint anyway to make sure the server still knows what clients are connected. It could have never started and this be triggered by reset-cancel. */}

    if( clientSocketIds[roomCode].length ) return false; // there are still more clients

    streamerMediaReady[roomCode] = false;
    clientMediaReady[roomCode] = false;
    serverSocketIds[roomCode] = null;
    clientSocketIds[roomCode] = [];
    startedClientIds[roomCode] = [];
    await menuPages[roomCode].close();
    menuPages[roomCode] = null;
    if( playlists[roomCode] ) {
        for( let song of playlists[roomCode] ) {
            let file = getFileFromUrl(song.youtubeUrl, roomCode);
            console.log("deleting: " + file);
            fs.unlink(file, function() {});
        }
    }
    return Promise.resolve(false);
}
