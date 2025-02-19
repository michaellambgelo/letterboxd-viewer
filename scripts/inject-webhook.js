const fs = require('fs');

// Get the webhook URL from command line argument
const webhookUrl = process.argv[2];
if (!webhookUrl) {
    console.error('No webhook URL provided');
    process.exit(1);
}

// Read the index.html file
const indexPath = 'index.html';
let content = fs.readFileSync(indexPath, 'utf8');

// Find and replace the webhook URL line
const searchString = 'let webhookUrl = null;';
const replaceString = `const webhookUrl = "${webhookUrl}"; // Injected by GitHub Actions`;

if (!content.includes(searchString)) {
    console.error('Could not find the webhook URL placeholder');
    process.exit(1);
}

// Replace the line
content = content.replace(searchString, replaceString);

// Verify the replacement
if (!content.includes(replaceString)) {
    console.error('Failed to inject webhook URL');
    process.exit(1);
}

// Write the file back
fs.writeFileSync(indexPath, content, 'utf8');

console.log('Successfully injected webhook URL');
