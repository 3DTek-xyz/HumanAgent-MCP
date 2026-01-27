const { JSONPath } = require('jsonpath-plus');
const fs = require('fs');
const path = require('path');

// Load the test JSON
const jsonPath = path.join(__dirname, 'src/mcp/RuleFailed.json');
const testJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('🎯 FOUND THE TARGET! Testing exact replacement scenarios...\n');

// The winning JSONPath expressions
const workingPaths = [
    '$.messages[2].content', // Direct path to content
    '$.messages[?(@.role === "user" && @.content.includes("BLAH BLAH BLAH"))].content', // Filter-based
];

workingPaths.forEach((path, index) => {
    console.log(`\n=== Test ${index + 1}: ${path} ===`);
    
    try {
        const results = JSONPath({ 
            path, 
            json: testJson,
            resultType: 'all'
        });
        
        if (results.length > 0) {
            const result = results[0];
            console.log(`✅ Match found at: ${result.path}`);
            
            // Show the current content with userRequest highlighted
            const content = result.value;
            const userRequestMatch = content.match(/(<userRequest>)(.*?)(<\/userRequest>)/s);
            
            if (userRequestMatch) {
                console.log(`\n📋 Current userRequest content:`);
                console.log(`   "${userRequestMatch[2]}"`);
                
                // Show what the replacement would look like
                const newContent = content.replace(
                    /(<userRequest>)(.*?)(<\/userRequest>)/s, 
                    '$1\nTell Me A Joke\n$3'
                );
                
                console.log(`\n🔄 After replacement:`);
                const newUserRequestMatch = newContent.match(/(<userRequest>)(.*?)(<\/userRequest>)/s);
                if (newUserRequestMatch) {
                    console.log(`   "${newUserRequestMatch[2]}"`);
                }
                
                console.log(`\n📝 For your proxy rule:`);
                console.log(`   JSONPath: ${path}`);
                console.log(`   Replacement: Use the entire new content string`);
                
                // Show a truncated version of what the replacement string would be
                console.log(`\n📄 Replacement string (first 200 chars):`);
                console.log(`   "${newContent.substring(0, 200)}..."`);
                
            } else {
                console.log('❌ No <userRequest> tags found in content');
            }
        }
    } catch (error) {
        console.log(`❌ Error: ${error.message}`);
    }
});

// Also test the original JSONPath from Ben's rule
console.log(`\n=== Testing Ben's Original Rule ===`);
const benPath = '$.messages[?(@.role === "user" && @.content.startsWith("<context>"))].content';
console.log(`JSONPath: ${benPath}`);

try {
    const results = JSONPath({ 
        path: benPath, 
        json: testJson,
        resultType: 'all'
    });
    
    console.log(`Found ${results.length} matches with Ben's original rule`);
    if (results.length > 0) {
        console.log('✅ Ben\'s rule would work! But it targets the wrong content...');
        console.log('   It targets messages starting with <context>, not containing <userRequest>');
    } else {
        console.log('❌ Ben\'s rule doesn\'t match - message doesn\'t start with <context>');
    }
} catch (error) {
    console.log(`❌ Error with Ben's rule: ${error.message}`);
}