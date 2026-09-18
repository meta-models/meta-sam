/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-butter/theme.css';
import '@astryxdesign/theme-gothic/theme.css';
import '@astryxdesign/theme-matcha/theme.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/theme-stone/theme.css';
import '@astryxdesign/theme-y2k/theme.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing application root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
