function missingDatabaseSchema(error) {
  return ['42P01', '42703'].includes(String(error?.code || ''));
}

async function schemaProbe(probe) {
  try {
    await probe();
    return true;
  } catch (error) {
    if (missingDatabaseSchema(error)) return false;
    throw error;
  }
}

module.exports = { missingDatabaseSchema, schemaProbe };
