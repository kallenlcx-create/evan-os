const fs = require('fs');
const html = fs.readFileSync('dist/index.html', 'utf8');
const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
const css = styleMatch[1];

// Check if there's a global bg-white rule that could override Card themes
const bgWhiteRules = css.split('}').filter(r => r.includes('.bg-white') && r.includes('background'));
console.log('bg-white CSS rules:');
bgWhiteRules.forEach(r => console.log('  ', r.trim().substring(0, 150)));

// Check the order: which comes first, bg-white or bg-orange-50?
const bgWhiteIdx = css.indexOf('.bg-white{');
const bgOrangeIdx = css.indexOf('.bg-orange-50{');
console.log('\nbg-white at index:', bgWhiteIdx);
console.log('bg-orange-50 at index:', bgOrangeIdx);
console.log('bg-white comes first:', bgWhiteIdx < bgOrangeIdx);

// Check if there's a card-related CSS that forces white background
const cardBgRules = css.split('}').filter(r => 
  (r.includes('card') || r.includes('Card')) && r.includes('background')
);
console.log('\nCard-related bg rules:', cardBgRules.length);
cardBgRules.forEach(r => console.log('  ', r.trim().substring(0, 150)));
