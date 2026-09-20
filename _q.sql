select to_char(to_timestamp(floor(extract(epoch from created)/300)*300), 'HH24:MI') as bucket5min,
       coalesce(status_code::text, left(error_msg, 22)) as result,
       count(*) as n
from net._http_response
where created > '2026-09-20 17:00+00'
group by 1, 2
order by 1, 2;
