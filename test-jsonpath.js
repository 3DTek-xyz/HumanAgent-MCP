const { JSONPath } = require('jsonpath-plus');
const fs = require('fs');
const path = require('path');

// Load the test JSON
const jsonPath = path.join(__dirname, 'src/mcp/RuleFailed.json');
const testJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('Testing JSONPath expressions against RuleFailed.json...\n');

// Test different JSONPath expressions
const expressions = [
    // Try to find userRequest content
    '$.messages[?(@.content && @.content.includes("<userRequest>"))]',
    '$.messages[*].content[?(@.includes("<userRequest>"))]',
    '$.messages[?(@.content.match(/<userRequest>/))].content',
    '$.messages[2].content',  // Based on structure, might be index 2
    '$.messages[?(@.role === "user")][-1].content',  // Last user message
    '$.messages[?(@.role === "user" && @.content.includes("BLAH BLAH BLAH"))].content',
    '$.messages[?(@.content.includes("BLAH BLAH BLAH"))]',
    '$..userRequest',  // Try to find userRequest anywhere
    '$..content[?(@.includes("BLAH BLAH BLAH"))]',
    '$.messages[*][?(@.includes && @.includes("BLAH BLAH BLAH"))]',
];

expressions.forEach((expr, index) => {
    try {
        console.log(`\n${index + 1}. Testing: ${expr}`);
        
        const results = JSONPath({ 
            path: expr, 
            json: testJson,
            resultType: 'all'
        });
        
        console.log(`   Found ${results.length} matches:`);
        
        if (results.length > 0) {
            results.forEach((result, i) => {
                console.log(`   [${i}] Path: ${result.path}`);
                console.log(`   [${i}] Value preview: ${JSON.stringify(result.value).substring(0, 100)}...`);
            });
        }
        
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
    }
});

// Now let's examine the structure to understand what we're dealing with
console.log('\n\n=== JSON STRUCTURE ANALYSIS ===');
console.log('Number of messages:', testJson.messages?.length || 'N/A');

if (testJson.messages) {
    testJson.messages.forEach((msg, i) => {
        console.log(`\nMessage ${i}:`);
        console.log(`  Role: ${msg.role}`);
        console.log(`  Content preview: ${JSON.stringify(msg.content).substring(0, 150)}...`);
        
        // Check if this message contains our target
        if (msg.content && msg.content.includes('BLAH BLAH BLAH')) {
            console.log(`  🎯 THIS MESSAGE CONTAINS "BLAH BLAH BLAH"`);
            console.log(`  📍 JSONPath to this message: $.messages[${i}]`);
            console.log(`  📍 JSONPath to content: $.messages[${i}].content`);
        }
    });
}