/*
  Optional: your own link-import helper (a free Cloudflare Worker).
  Only needed if importing recipes from links stops working. See the README.

  Change the address below to where your recipe book lives, with no slash at the end.
*/
const MY_SITE = 'https://YOUR-USERNAME.github.io';

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': MY_SITE, 'Vary': 'Origin' };
    if (request.headers.get('Origin') !== MY_SITE) return new Response('Not allowed', { status: 403 });
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('Missing ?url=', { status: 400, headers: cors });
    try {
      const page = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      return new Response(page.body, {
        status: page.status,
        headers: { ...cors, 'Content-Type': page.headers.get('Content-Type') || 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    } catch (err) {
      return new Response('Could not reach that page', { status: 502, headers: cors });
    }
  },
};
