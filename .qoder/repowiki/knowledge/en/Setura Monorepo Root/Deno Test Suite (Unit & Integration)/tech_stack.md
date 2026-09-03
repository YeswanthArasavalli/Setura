Deno runtime with Deno's built-in test runner (`Deno.test`) and
`deno.land/std@0.224.0/assert`; Zod schemas imported directly for validation
tests; integration tests call the `supabase` CLI (`supabase status -o json`) to
discover local stack endpoints.
