const { JSONPath } = require('jsonpath-plus');
const fs = require('fs');
const path = require('path');

// Load the test JSON
const jsonPath = path.join(__dirname, 'src/mcp/RuleFailed.json');
const testJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('🎯 CREATING EXACT REPLACEMENT STRING FOR PROXY RULE...\n');

// Get the target content
const results = JSONPath({ 
    path: '$.messages[2].content', 
    json: testJson,
    resultType: 'all'
});

if (results.length > 0) {
    const originalContent = results[0].value;
    
    // Create the replacement content
    const newContent = originalContent.replace(
        /(<userRequest>)(.*?)(<\/userRequest>)/s, 
        '$1\nTell Me A Joke\n$3'
    );
    
    console.log('📋 ORIGINAL CONTENT:');
    console.log('=' .repeat(80));
    console.log(originalContent);
    console.log('=' .repeat(80));
    
    console.log('\n🔄 NEW CONTENT:');
    console.log('=' .repeat(80));
    console.log(newContent);
    console.log('=' .repeat(80));
    
    console.log('\n📝 EXACT PROXY RULE CONFIGURATION:');
    console.log('=' .repeat(80));
    console.log('URL Pattern: https://api.individual.githubcopilot.com/chat/completions');
    console.log('JSONPath: $.messages[?(@.role === "user" && @.content.includes("BLAH BLAH BLAH"))].content');
    console.log('');
    console.log('Replacement (copy this exact string):');
    console.log('-'.repeat(40));
    console.log(JSON.stringify(newContent));
    console.log('-'.repeat(40));
    
    // Save the replacement string to a file for easy copying
    fs.writeFileSync('replacement-string.txt', newContent);
    console.log('\n💾 Replacement string saved to: replacement-string.txt');
    
    console.log('\n🔧 ALTERNATIVE APPROACH - Target userRequest specifically:');
    console.log('If you want to be more specific about targeting userRequest tags:');
    console.log('JSONPath: $.messages[?(@.content && @.content.includes("<userRequest>"))].content');
}