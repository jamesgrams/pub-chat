# Pub Chat

An application that allows you to chat with friends and play music together. Pub Chat uses a server-client pattern and WebRTC. The server runs puppeteer and has a Chromium instance communicating with clients.

## Usage

1. Clone this repository.
2. Run `npm install`.
3. Run `npm start`.
4. Connect to the server on your clients.

## Notes

WebRTC requires HTTPS beyond your private network and getUserMedia requires HTTPS beyond `localhost`, so for testing, it may be a good idea to add the IP you are testing on (http://XXX.XXX.XXX.XXX) to the chrome flag `#unsafely-treat-insecure-origin-as-secure`.