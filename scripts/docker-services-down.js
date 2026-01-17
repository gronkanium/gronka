#!/usr/bin/env node

import { checkDockerDaemon, info, execOrError } from './utils.js';

const SERVICES_COMPOSE = 'docker-compose.services.yml';

checkDockerDaemon();

info('Stopping dependency services...');

execOrError(`docker compose -f ${SERVICES_COMPOSE} down`, 'Failed to stop services');

info('Services stopped');
