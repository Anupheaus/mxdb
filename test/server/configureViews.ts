import Koa from 'koa';
import Pug from 'koa-pug';
import path from 'path';

export function configureViews(app: Koa): void {
  new Pug({
    viewPath: path.resolve(__dirname, './views'),
    app,
  });
  app.use(ctx => ctx.render('index', {}, {}, true));
}
