[X] Assess / Set logging path and details correctly for release & dev.
[ ] Create a new readme
[X] Consider how updates to the extension will work.

[X] Override Prompt Script is not generated from exact coded system tool description - seems to be stale - where is the info coming from for the override creation?
[X] Can we include an option to enable logging and set logging to take place in the .vscode directory of the active workspace. It should be an option that the user can turn on in the cog. And should be off by default. 
[X] There should be an SSE sent to website when chat is named to force it to update the name.
[X] Consider reminding AI to allways use this method for replies in each response unless some keyword is included - we can add this to the outgoing chat messages and just strip it from what we show in the chat log?
[X] We should look for and exlude and tool named "example_custom_tool" from the /tools endpoint as it should not be advertised as a real tool to the AI
[ ] The updates / overrides seem to be advertised @ /tools though the Configure tools screen on vs code doesnt show that the new description - the ai reports when asked the original description not one recently read in by the reload override method - look here for possible help: https://code.visualstudio.com/blogs/2025/05/12/agent-mode-meets-mcp 
[ ] The message formatting from the ai, cariagge returns etc are not observed by the website - its just a big string in one paragraph.  Can we fix this?  AI message formatting looks fine in vscode interface.  WEB ITERFACE STILL SHOWS EVERYTHING ON ONE LINE.
[ ] When sending a message from VS code it looses some history of the chat - seems to keep its own messages but looses old ai agent messages and any from the web client.
[ ] Publish Extension - WHEN ALL ELSE IS DONE!
[ ] Consider how a user might also interact from their mobile phone.  Dont want to do port forwarding and setting up web servers etc.  How about using telegram as an interface - could this work? Look into it. 
[ ] Would be great if I could paste in an image or screen shot - Copilot agent allows this in the vscode plugin.
[ ]  put an option in the MCP.json and the global setup to change the default timout to a new value
