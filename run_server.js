const { spawn } = require('child_process');
const fs = require('fs');

const server = spawn('node', ['server.js']);
const logStream = fs.createWriteStream('server_output.txt');

server.stdout.pipe(logStream);
server.stderr.pipe(logStream);

console.log('Server started, output redirecting to server_output.txt');

setTimeout(() => {
    process.exit(0);
}, 10000); // Run for 10 seconds
