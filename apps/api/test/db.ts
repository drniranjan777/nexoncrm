export const testDbConfigured = () => {
  const url = process.env.TEST_DATABASE_URL;
  return !!url && !url.includes('YOUR_PASSWORD');
};
