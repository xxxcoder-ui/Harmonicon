import { BaseModel } from './base.js';
import { PositionModel } from './position.js';
import { SequencedEventModel } from './sequenced_event.js';
import { SequencedEventLogModel } from './sequenced_event_log.js';
import { mapSeries } from '@composer/util';

export class RendererModel extends BaseModel {
  static drivers = {};

  static properties = {
    session: {},
    driver: {},
  }

  static register (name, driver) {
    this.drivers[name] = driver;
  }

  get position () {
    return this.driver.position;
  }

  get state () {
    return this.driver.state;
  }


  // Renderers
  // ---------

  async render () {
    this.session.infer();

    await this.reset();
    await this.renderSession(this.session)
    await this.goToBeginning();

    return this;
  }

  async renderSession (session) {
    this.driver.session = session;
    this.driver.renderer = this;

    this.logger.debug(`render.session: [+] name = ${this.session.name}`);
    this.logger.debug(`render.session:     number of events = ${this.session.events.length}`);
    this.logger.debug(`render.session:     number of phrases = ${this.session.phrases.length}`);
    this.logger.debug(`render.session:     number of instruments = ${this.session.instruments.length}`);
    this.logger.debug(`render.session:     number of tracks = ${this.session.tracks.length}`);
    this.logger.debug(`render.session:     number of patches = ${this.session.patches.length}`);

    await this.renderSessionEvents();
    await this.renderInstruments();
    await this.renderEffects();
    await this.renderPhrases();
    await this.renderTracks();
    await this.renderPatches();
    await this.renderEnd();

    return;
  }

  async renderSessionEvents () {
    return this.session.events.mapSeries(this.renderSessionEvent.bind(this));
  }

  async renderSessionEvent (event) {
    this.logger.debug(`render.session.event: [+] at = ${event.at}`);
    this.logger.debug(`render.session.event:     type = ${event.type}`);
    this.logger.debug(`render.session.event:     value = ${event.value}`);

    return this.scheduleEvent({ event });
  }

  async renderInstruments () {
    return this.session.instruments.mapSeries(this.renderInstrument.bind(this));
  }

  async renderInstrument (instrument) {
    const node = this.createNode({
      type: 'instrument',
      name: instrument.name, 
      node: await instrument.fn({})
    });

    this.logger.info(`render.instrument: [+] name = ${instrument.name}`);
    this.logger.debug(`render.instrument:     fn = ${typeof instrument.fn}`);
    this.logger.debug(`render.instrument:     rendered = ${node.node}`);
    this.logger.debug(`render.instrument:     loaded = ${node.loaded}`);

    if (node.loaded) {
      return;
    }

    // Audio node may need time to load samples and external objects
    return new Promise((accept, reject) => {
      const interval = setInterval(() => {
        this.logger.debug(`render.instrument:     loaded = ${node.loaded}`);

        if (node.loaded) {
          clearInterval(interval);
          accept();
        }
      }, 500);
    });
  }

  async renderEffects () {
    return this.session.effects.mapSeries(this.renderEffect.bind(this));
  }

  async renderEffect (effect) {    
    const node = this.createNode({
      type: 'effect',
      name: effect.name,
      node: await effect.fn()
    });

    this.logger.info(`render.effect: [+] name = ${effect.name}`);
    this.logger.debug(`render.effect:     fn = ${typeof effect.fn}`);
    this.logger.debug(`render.effect:     rendered = ${node.node}`);
  }

  async renderPhrases() {
    return this.session.phrases.mapSeries(this.renderPhrase.bind(this));
  }

  async renderPhrase (phrase) {
    this.logger.info(`render.session.phrase: [+] name = ${phrase.name}`);
    this.logger.debug(`render.session.phrase:     number of steps = ${phrase.steps.length}`);

    this.cache.phrases[phrase.name] = phrase;
  }

  async renderTracks () {

    // Create a root main output track
    this.createNode({
      type: 'track',
      name: 'main',
      root: true,
    });

    return this.session.tracks.mapSeries(this.renderTrack.bind(this));
  }

  async renderTrack (track) {
    const inputs = track.getSequenceableInputs();

    // Create an audio node for this track
    await this.createNode({
      type: 'track',
      name: track.name
    });

    this.logger.info(`render.session.track: [+] name = ${track.name}`);
    this.logger.debug(`render.session.track:     number of events = ${track.events.length}`);
    this.logger.debug(`render.session.track:     number of inputs = ${track.inputs.length}`);

    if (inputs.length === 0) {
      this.logger.error(`render.session.track:     no input nodes; is a patch missing?`);
      return;
    }

    return mapSeries(inputs, async (input, i) => {
      const node = this.getNode(input.inputType, input.input).node;

      this.logger.debug(`render.session.track:     input ${i} source = ${input.inputType}:${input.input} (${node})`);

      return await track.events.mapSeries(async (event) => {
        return this.renderTrackEvent({ event, track, instrument: node });
      });  
    });
  }

  async renderTrackEvent ({ event, track, instrument }) {
    this.logger.info(`render.session.track.event: [+] at = ${event.at}`);
    this.logger.debug(`render.session.track.event:     type = ${event.type}`);
    this.logger.debug(`render.session.track.event:     value = ${event.value}`);
    this.logger.debug(`render.session.track.event:     instrument = ${instrument}`);

    return this.scheduleEvent({ event, track, instrument })
  }

  async renderPatches () {
    return this.session.patches.mapSeries(this.renderPatch.bind(this));
  }

  async renderPatch (patch) {
    const inputNode = this.getNode(patch.inputType, patch.input);
    const outputNode = this.getNode(patch.outputType, patch.output);

    this.logger.info(`render.session.patch: [+] path = ${patch.inputType}:${patch.input} -> ${patch.outputType}:${patch.output}`);
    this.logger[inputNode ? 'debug' : 'error'](`render.session.patch:     input node = ${inputNode}`);
    this.logger[outputNode ? 'debug' : 'error'](`render.session.patch:     output node = ${outputNode}`);

    if (inputNode && outputNode) {
      inputNode.connect(outputNode);
    }
  }

  async renderEnd() {
    const lastEvent = this.cache.events.last;
    const sustainFor = 2;
    const stopAt = PositionModel.parse({
      measure: lastEvent ? Number(lastEvent.at.measure) + sustainFor : sustainFor,
      beat: 0,
      subdivision: 0
    });

    this.logger.info(`render.session.end: [+] at = ${stopAt.toMBS()}`);
    this.logger.debug(`render.session.end:     last event = ${lastEvent ? lastEvent.at : 'unknown'}`)
    this.logger.debug(`render.session.end:     sustain for = ${sustainFor} measures`);

    return this.scheduleEvent({
      log: false,
      event: new SequencedEventModel({
        value: true,
        type: 'end',
        at: stopAt
      }),
    });
  }


  // Events
  // ------

  async scheduleEvent({ event, log = true }) {

    // Find driver scheduler for this event
    const scheduler = this.driver.schedulers[event.type];

    // Add to global event log
    if (log) {
      this.cache.events.push(event);
    }

    if (scheduler) {
      return await scheduler.apply(this, arguments);
    }
    else {
      this.logger.error(`missing scheduler for type "${event.type}"`);
    }
  }

  async unscheduleAll() {
    return this.driver.unscheduleAll();
  }


  // Audio nodes
  // -----------

  createNode({ type, name, node, root }) {
    this.cache.nodes = this.cache.nodes || {};
    this.cache.nodes[type] = this.cache.nodes[type] || {};

    return this.cache.nodes[type][name] = this.driver.createNode({
      root, node, name: `${type}:${name}`,
    });
  }

  getNode(type, name) {
    return this.cache.nodes[type][name];
  }


  // Cache
  // -----

  resetCache () {
    this.cache = {
      nodes: {},
      tracks: {},
      phrases: {},
      events: new SequencedEventLogModel()
    };
  }


  // Transport
  // ---------

  play (options) {
    options = Object.assign({
      at: '0:0:0',
      markTime: false,
      markTimeInterval: 0.5
    }, options);

    this.driver.setTransportPosition(options.at);

    if (options.markTime) {
      this.markTime({ interval: options.markTimeInterval });
    }

    return this.driver.play();
  }

  pause () {
    return this.driver.pause();
  }

  goToBeginning () {
    return this.driver.setTransportPosition('0:0:0');
  }


  // Misc
  // ----

  async reset () {
    this.resetCache();

    return this.unscheduleAll();
  }

  markTime({ interval }) {
    setInterval(() => {
      const {
        ticks,
        measure,
        beat,
        subdivision,
        realtime
      } = this.position;

      this.logger.info(`markTime: transport = ${measure}:${beat}:${subdivision} (${realtime}s, ${ticks}t)`);
    }, interval * 1000);
  }

}

RendererModel.init();