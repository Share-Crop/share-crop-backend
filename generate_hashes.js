const bcrypt = require('bcrypt');
const fs = require('fs');

async function generateHashes() {
    const passwords = ['31Maggiorana+', 'farmer123', 'buyer123'];
    const results = {};
    for (const pw of passwords) {
        results[pw] = await bcrypt.hash(pw, 10);
    }
    fs.writeFileSync('hashes.json', JSON.stringify(results, null, 2));
    console.log('Hashes written to hashes.json');
}

generateHashes();
