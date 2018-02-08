import React from 'react';
import {render} from 'react-dom';
import {Provider} from 'react-redux';
import {store} from './state';
import App from './App';
import registerServiceWorker from './registerServiceWorker';
import 'typeface-roboto';

render(
  <Provider store={store}>
    <App />
  </Provider>,
  document.querySelector('#root')
);
registerServiceWorker();
