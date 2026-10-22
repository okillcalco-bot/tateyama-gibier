-- 20260907_training_modules.sql のロールバック

drop function if exists public.training_admin_stats();
drop function if exists public.training_my_completions(text);
drop function if exists public.training_submit_completion(text, text, text, int, int);

drop table if exists training_completions;
drop table if exists training_modules;
