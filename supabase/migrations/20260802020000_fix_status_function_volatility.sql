begin;

alter function public.middleware_queue_status(integer) volatile;

commit;
