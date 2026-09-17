/* Supabase project settings.
   Both values are public by design — the anon key only grants what your row level
   security policies allow, which is why supabase/schema.sql locks every table to
   signed-in users. Find them in Supabase under Project Settings -> API. */
window.SLATE_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",

  /* Identifies this app to the browser's push service when a device subscribes.
     Public by design; the matching private key lives only in Vercel's env
     (VAPID_PRIVATE_KEY). The pair is permanent — replace one and you must
     replace the other, and every device has to re-enable notifications. */
  vapidPublicKey: "BPJSjr3f3pa0ugPoXN0hyuOw5paUDSua7xlWB66IyUphIVImkE6P8JHDw8nES09MOPk7St-Z7VZYWK1blvUkfUg"
};
