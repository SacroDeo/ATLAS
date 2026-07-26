#!/usr/bin/env node
// Migration instructions for Supabase
const fs = require('fs');
const path = require('path');

console.log('\n' + '='.repeat(80));
console.log('DATABASE MIGRATION REQUIRED');
console.log('='.repeat(80));
console.log('\nTo complete the security fixes, run this SQL in your Supabase dashboard:\n');
console.log('1. Go to: https://supabase.com/dashboard/project/swiftrnhvrkezrgxzoml/editor');
console.log('2. Click "SQL Editor" in the left sidebar');
console.log('3. Click "New Query"');
console.log('4. Copy and paste the SQL below:');
console.log('\n' + '-'.repeat(80) + '\n');

const migrationPath = path.join(__dirname, '../migrations/add_webhook_idempotency.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log(sql);

console.log('\n' + '-'.repeat(80));
console.log('\n5. Click "Run" or press Ctrl+Enter');
console.log('6. Verify you see "Success. No rows returned"');
console.log('\n' + '='.repeat(80));
console.log('After running the migration, restart your server with: npm start');
console.log('='.repeat(80) + '\n');
