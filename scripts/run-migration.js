#!/usr/bin/env node
// Script to run database migrations via Supabase
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('../src/config/supabase');

async function runMigration() {
  console.log('🔄 Running database migration...\n');

  const migrationPath = path.join(__dirname, '../migrations/add_webhook_idempotency.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Split by semicolon and filter out comments/empty statements
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--') && s !== '');

  let successCount = 0;
  let errorCount = 0;

  for (const statement of statements) {
    try {
      console.log(`Executing: ${statement.substring(0, 60)}...`);

      const { error } = await supabase.rpc('exec_sql', { sql_query: statement });

      if (error) {
        // Try direct query for some statements that might not work with rpc
        const { error: directError } = await supabase.from('_').select('*').limit(0);

        // For DDL statements, we need to use raw SQL via PostgREST
        // Since Supabase client doesn't support raw DDL, log instruction
        console.log(`⚠️  Statement needs manual execution in Supabase SQL Editor`);
        console.log(`   ${statement}\n`);
      } else {
        console.log('✅ Success\n');
        successCount++;
      }
    } catch (err) {
      console.error(`❌ Error: ${err.message}\n`);
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Migration Summary:`);
  console.log(`  Success: ${successCount} statements`);
  console.log(`  Errors: ${errorCount} statements`);
  console.log('='.repeat(60));

  if (errorCount > 0) {
    console.log('\n⚠️  Some statements failed. Please run the migration manually:');
    console.log('   1. Go to Supabase Dashboard → SQL Editor');
    console.log('   2. Copy contents of migrations/add_webhook_idempotency.sql');
    console.log('   3. Run the SQL query');
  }
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
