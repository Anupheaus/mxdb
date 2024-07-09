import Koa from 'koa';
import serve from 'koa-static';
import path from 'path';

export function configureStaticFiles(app: Koa) {
  app.use(serve(path.resolve(__dirname)));
}
