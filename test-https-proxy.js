#!/usr/bin/env node

/**
 * Test script to verify HTTPS proxy interception
 * Usage: node test-https-proxy.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
    log(`\n${'='.repeat(60)}`, 'cyan');
    log(title, 'cyan');
    log(`${'='.repeat(60)}\n`, 'cyan');
}

async function testHttpProxy(proxyPort) {
    return new Promise((resolve, reject) => {
        log(`Testing HTTP request through proxy on port ${proxyPort}...`, 'blue');
        
        const options = {
            hostname: 'example.com',
            port: proxyPort,
            path: 'http://example.com/',
            method: 'GET',
            headers: {
                'Host': 'example.com',
                'User-Agent': 'HumanAgent-Proxy-Test/1.0'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                log(`✅ HTTP Status: ${res.statusCode}`, 'green');
                log(`   Headers: ${JSON.stringify(res.headers).substring(0, 100)}...`, 'green');
                resolve({ protocol: 'HTTP', status: res.statusCode, success: true });
            });
        });

        req.on('error', (error) => {
            log(`❌ HTTP Error: ${error.message}`, 'red');
            resolve({ protocol: 'HTTP', success: false, error: error.message });
        });

        req.setTimeout(5000);
        req.end();
    });
}

async function testHttpsProxy(proxyPort, caCertPath) {
    return new Promise((resolve, reject) => {
        log(`Testing HTTPS request through proxy on port ${proxyPort}...`, 'blue');
        
        // Configure HTTPS agent to trust the proxy CA
        const agent = new https.Agent({
            ca: fs.readFileSync(caCertPath),
            rejectUnauthorized: false // For testing - allow self-signed certs
        });

        const options = {
            hostname: 'example.com',
            port: proxyPort,
            path: '/',
            method: 'GET',
            agent: agent,
            headers: {
                'Host': 'example.com',
                'User-Agent': 'HumanAgent-Proxy-Test/1.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                log(`✅ HTTPS Status: ${res.statusCode}`, 'green');
                log(`   Headers: ${JSON.stringify(res.headers).substring(0, 100)}...`, 'green');
                resolve({ protocol: 'HTTPS', status: res.statusCode, success: true });
            });
        });

        req.on('error', (error) => {
            log(`❌ HTTPS Error: ${error.message}`, 'red');
            resolve({ protocol: 'HTTPS', success: false, error: error.message });
        });

        req.setTimeout(5000);
        req.end();
    });
}

async function findCACertificate() {
    // Look for CA certificate in common locations
    const possiblePaths = [
        path.join(process.env.HOME, '.vscode/extensions/humanagent-mcp/global-storage/ca.pem'),
        path.join(process.env.HOME, '.vscode-insiders/extensions/humanagent-mcp/global-storage/ca.pem'),
        './ca.pem'
    ];

    for (const certPath of possiblePaths) {
        if (fs.existsSync(certPath)) {
            log(`Found CA certificate: ${certPath}`, 'green');
            return certPath;
        }
    }

    log(`⚠️  CA certificate not found. Searched paths:`, 'yellow');
    possiblePaths.forEach(p => log(`   - ${p}`, 'yellow'));
    return null;
}

async function runTests() {
    logSection('HumanAgent HTTPS Proxy Test Suite');

    // Hardcoded proxy port for testing (should match what extension uses)
    const proxyPort = 3737; // Production port

    log(`Looking for CA certificate...`, 'blue');
    const caCertPath = await findCACertificate();

    if (!caCertPath) {
        log(`\n❌ CA certificate not found. Make sure the extension has been activated once.`, 'red');
        log(`   The extension should have created the CA certificate in global storage.`, 'yellow');
        process.exit(1);
    }

    logSection('Test Results');

    const results = [];

    // Test HTTP
    log(`\n[1/2] Testing HTTP interception...`, 'cyan');
    const httpResult = await testHttpProxy(proxyPort);
    results.push(httpResult);

    // Test HTTPS (only if CA found)
    log(`\n[2/2] Testing HTTPS interception...`, 'cyan');
    const httpsResult = await testHttpsProxy(proxyPort, caCertPath);
    results.push(httpsResult);

    // Summary
    logSection('Test Summary');
    
    const successCount = results.filter(r => r.success).length;
    const totalTests = results.length;

    log(`Passed: ${successCount}/${totalTests}`, successCount === totalTests ? 'green' : 'red');
    log(`\nDetailed Results:`, 'cyan');
    
    results.forEach(result => {
        const status = result.success ? '✅' : '❌';
        const details = result.success 
            ? `Status ${result.status}` 
            : `Error: ${result.error}`;
        log(`${status} ${result.protocol}: ${details}`);
    });

    if (successCount === totalTests) {
        log(`\n🎉 All tests passed! HTTPS proxy is working correctly.`, 'green');
        process.exit(0);
    } else {
        log(`\n⚠️  Some tests failed. Check the proxy logs for details.`, 'yellow');
        log(`   You can view proxy logs in the HumanAgent chat webview.`, 'yellow');
        process.exit(1);
    }
}

// Run tests
runTests().catch(error => {
    log(`\n❌ Test suite failed: ${error.message}`, 'red');
    process.exit(1);
});
