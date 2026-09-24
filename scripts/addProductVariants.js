import pool from '../src/config/db.js'

async function main() {
  const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'variants'")
  if (!columns.length) {
    await pool.query('ALTER TABLE products ADD COLUMN variants JSON NULL AFTER price')
    console.log('Added products.variants')
  } else {
    console.log('products.variants already exists')
  }
  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
