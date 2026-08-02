insert into public.integration_worker_leases (destination)
values ('human_os')
on conflict (destination) do nothing;
