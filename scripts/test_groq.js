require('dotenv').config();
const { generateCoupleBio } = require('../src/utils/ai');

async function testGroq() {
  console.log('Testing Groq AI with new model...');
  const dummyData = [
    { question: 'Life Stage', answers: ['Building careers', 'Newly settled'] },
    { question: 'Favorite Activities', answers: ['Weekend trips', 'Casual drinks'] },
    { question: 'What makes a good match', answers: ['Shared interests', 'Small groups'] }
  ];

  try {
    const result = await generateCoupleBio(dummyData);
    console.log('\n--- SUCCESS ---');
    console.log('Bio:', result.bio);
    console.log('Match Criteria:', JSON.stringify(result.matchCriteria));
    process.exit(0);
  } catch (err) {
    console.error('\n--- FAILED ---');
    console.error(err);
    process.exit(1);
  }
}

testGroq();
