export class MerchantSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.productsCache = null;
    this.ordersCache = null;
    this.settingsCache = null;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const merchantId = url.searchParams.get('merchant_id');

    // 1. التعامل مع طلبات تحديث الكاش القادمة من الـ Worker
    if (request.method === 'POST') {
      try {
        const payload = await request.json();
        
        if (url.pathname === '/sync-product') {
          if (this.productsCache !== null) {
             const idx = this.productsCache.findIndex(p => String(p.id) === String(payload.product.id));
             if (idx !== -1) {
                this.productsCache[idx] = payload.product;
             } else {
                this.productsCache.unshift(payload.product);
             }
          }
          this.broadcast({ event: 'product_updated', product: payload.product });
          return new Response('Sync OK', { status: 200 });
        }

        if (url.pathname === '/sync-order') {
          if (this.ordersCache !== null) {
             const idx = this.ordersCache.findIndex(o => String(o.ticket_id) === String(payload.order.ticket_id));
             if (idx !== -1) {
                this.ordersCache[idx] = payload.order;
             } else {
                this.ordersCache.unshift(payload.order);
             }
          }
          this.broadcast({ event: 'order_updated', order: payload.order });
          return new Response('Sync OK', { status: 200 });
        }

        if (url.pathname === '/sync-settings') {
          this.settingsCache = payload.settings;
          this.broadcast({ event: 'settings_updated', settings: payload.settings });
          return new Response('Sync OK', { status: 200 });
        }
      } catch (e) {
        return new Response('Bad Request', { status: 400 });
      }
    }

    // 2. ترقية الاتصال إلى WebSocket (دخول داشبورد التاجر)
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.sessions.add(server);
      server.accept();

      this.handleWebSocket(server, merchantId);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
  }

  async handleWebSocket(ws, merchantId) {
    ws.addEventListener('close', () => { this.sessions.delete(ws); });
    ws.addEventListener('error', () => { this.sessions.delete(ws); });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e) {}
    });

    try {
      // جلب البيانات غير المتوفرة في الكاش
      const promises = [];
      if (this.productsCache === null) {
        promises.push(
          this.env.DB.prepare(`SELECT * FROM products WHERE merchant_id = ? ORDER BY updated_at DESC`)
          .bind(merchantId).all().then(res => {
             this.productsCache = res.results.map(p => {
               try { p.options = JSON.parse(p.options || '[]'); } catch (e) { p.options = []; }
               return p;
             });
          })
        );
      }
      if (this.ordersCache === null) {
        promises.push(
          this.env.DB.prepare(`SELECT * FROM live_tickets WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 500`)
          .bind(merchantId).all().then(res => {
             this.ordersCache = res.results || [];
          })
        );
      }
      if (this.settingsCache === null) {
        promises.push(
          this.env.DB.prepare(`SELECT settings FROM users WHERE id = ?`)
          .bind(merchantId).first().then(res => {
             try { this.settingsCache = JSON.parse(res?.settings || '{}'); } catch(e) { this.settingsCache = {}; }
          })
        );
      }
      
      await Promise.all(promises);

      // إرسال جميع البيانات للعميل
      ws.send(JSON.stringify({
        event: 'initial_load',
        products: this.productsCache,
        orders: this.ordersCache,
        settings: this.settingsCache
      }));
    } catch (e) {
      ws.send(JSON.stringify({ event: 'error', message: 'فشل جلب البيانات الأولية' }));
    }
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    for (const session of this.sessions) {
      try {
        session.send(message);
      } catch (e) {
        this.sessions.delete(session);
      }
    }
  }
}
