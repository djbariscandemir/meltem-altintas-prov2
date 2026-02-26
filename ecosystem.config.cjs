/**
 * PM2 ecosystem config for meltem-bot
 * Loads .env and injects SUPABASE_SERVICE_ROLE_KEY into the process
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

module.exports = {
  apps: [
    {
      name: "meltem-bot",
      script: "scripts/fetchRevyWithLogin.js",
      cwd: "/opt/meltem-bot",
      env: {
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        REVY_PHONE: process.env.REVY_PHONE,
        REVY_PASSWORD: process.env.REVY_PASSWORD
      }
    }
  ]
};
