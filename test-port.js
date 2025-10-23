const net = require('net');
const http = require('http');

async function isPortInUseNet(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		
		server.listen(port, '127.0.0.1', () => {
			console.log(`NET: Port ${port} available - server created successfully`);
			server.close(() => resolve(false)); // Port is available
		});
		
		server.on('error', (err) => {
			console.log(`NET: Port ${port} in use - error: ${err.message}`);
			resolve(true); // Port is in use
		});
	});
}

async function isPortInUseHttp(port) {
	return new Promise((resolve) => {
		const server = http.createServer();
		
		server.listen(port, '127.0.0.1', () => {
			console.log(`HTTP: Port ${port} available - server created successfully`);
			server.close(() => resolve(false)); // Port is available
		});
		
		server.on('error', (err) => {
			console.log(`HTTP: Port ${port} in use - error: ${err.message}`);
			resolve(true); // Port is in use
		});
	});
}

console.log('Testing port 3737...');
Promise.all([isPortInUseNet(3737), isPortInUseHttp(3737)]).then(([netResult, httpResult]) => {
	console.log(`NET result - Port 3737 in use: ${netResult}`);
	console.log(`HTTP result - Port 3737 in use: ${httpResult}`);
	process.exit(0);
});