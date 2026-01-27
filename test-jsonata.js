const jsonata = require('jsonata');
const fs = require('fs');
const path = require('path');

// Load the test JSON
const jsonPath = path.join(__dirname, 'src/mcp/RuleFailed.json');
const testJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('🎯 TESTING JSONata FOR PRECISE JSON TRANSFORMATION...\n');

// JSONata expressions to test
const expressions = [
    // Transform only user messages containing userRequest
    `messages[role="user" and $contains(content, "<userRequest>")].{
        "role": role,
        "content": $replace(content, /<userRequest>.*?<\\/userRequest>/s, "<userRequest>Tell Me A Joke</userRequest>"),
        "copilot_cache_control": copilot_cache_control
    }`,
    
    // Full document transformation preserving structure  
    `{
        "messages": messages.{
            "role": role,
            "content": role = "user" and $contains(content, "<userRequest>") ? 
                $replace(content, /<userRequest>.*?<\\/userRequest>/s, "<userRequest>Tell Me A Joke</userRequest>") : 
                content,
            "copilot_cache_control": copilot_cache_control
        },
        "model": model,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "tools": tools
    }`,
    
    // Simpler - just get the transformed content field
    `messages[role="user" and $contains(content, "<userRequest>")].content.
     $replace($, /<userRequest>.*?<\\/userRequest>/s, "<userRequest>Tell Me A Joke</userRequest>")`
];

async function testJSONata() {
    for (let i = 0; i < expressions.length; i++) {
        console.log(`\n=== JSONata Test ${i + 1} ===`);
        console.log(`Expression: ${expressions[i]}`);
        
        try {
            const expression = jsonata(expressions[i]);
            const result = await expression.evaluate(testJson);
            
            console.log('✅ Success!');
            console.log('Result type:', Array.isArray(result) ? 'Array' : typeof result);
            
            if (Array.isArray(result)) {
                console.log(`Found ${result.length} matches`);
                result.forEach((item, index) => {
                    if (item && item.content) {
                        const userReq = item.content.match(/<userRequest>(.*?)<\/userRequest>/s);
                        if (userReq) {
                            console.log(`  [${index}] UserRequest: "${userReq[1].trim()}"`);
                        }
                    }
                });
            } else if (result && typeof result === 'object') {
                // Check if it's a full document transformation
                if (result.messages) {
                    console.log(`Transformed document with ${result.messages.length} messages`);
                    const userMsg = result.messages.find(m => m.role === 'user' && m.content.includes('<userRequest>'));
                    if (userMsg) {
                        const userReq = userMsg.content.match(/<userRequest>(.*?)<\/userRequest>/s);
                        console.log(`  UserRequest transformed to: "${userReq ? userReq[1].trim() : 'NOT FOUND'}"`);
                    }
                } else {
                    console.log('Result:', JSON.stringify(result, null, 2).substring(0, 200));
                }
            } else if (typeof result === 'string') {
                const userReq = result.match(/<userRequest>(.*?)<\/userRequest>/s);
                console.log(`  Transformed content - UserRequest: "${userReq ? userReq[1].trim() : 'NOT FOUND'}"`);
            }
            
        } catch (error) {
            console.log(`❌ Error: ${error.message}`);
        }
    }
}

// Test if jsonata is available
try {
    require('jsonata');
    testJSONata();
} catch (error) {
    console.log('❌ JSONata not installed. Install with: npm install jsonata');
    console.log('\n📝 CONCEPTUAL JSONata RULE CONFIGURATION:');
    console.log('================================');
    console.log('URL Pattern: https://api.individual.githubcopilot.com/chat/completions');
    console.log('JSONata Expression: messages[role="user" and $contains(content, "<userRequest>")].content.$replace($, /<userRequest>.*?<\\/userRequest>/s, "<userRequest>Tell Me A Joke</userRequest>")');
    console.log('Rule Type: JSONata Transformation (not replacement)');
    console.log('\nThis would:');
    console.log('1. Find user messages containing <userRequest>');
    console.log('2. Replace only the content between <userRequest> tags');
    console.log('3. Preserve all other content exactly as-is');
}