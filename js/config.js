// Over/Under — backend config.
//
// These are set: multi-phone rooms work out of the box for every phone
// that opens the site. (The anon key is public by design — access is
// controlled server-side by RLS + the RPCs in supabase/schema.sql.)
window.OU_CONFIG = {
  SUPABASE_URL: 'https://nvpgopnhpfpapgmeiwsx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52cGdvcG5ocGZwYXBnbWVpd3N4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTIzNjcsImV4cCI6MjA5OTA4ODM2N30.OmS9nasS4ODmF0Odrj12F2wXS379vCCkuEUQy9Edf_Q'
};
