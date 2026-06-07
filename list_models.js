require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
(async () => {
  try {
    const key = process.env.GEMINI_API_KEY || '';
    if (!key) {
      console.log('NO_KEY');
      return;
    }
    const client = new GoogleGenerativeAI(key);
    const svc = client.getModelService();
    const list = await svc.listModels();
    console.log(JSON.stringify(list.models.map(m => ({ name: m.name, supportedMethods: m.supportedMethods || [], displayName: m.displayName || '' })), null, 2));
  } catch (err) {
    console.error('ERR', err);
    process.exit(1);
  }
})();
