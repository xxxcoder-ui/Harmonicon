session('c major scale', async ({ session }) => {
  session.at.measure(0)
    .meter([ 4, 4 ])
    .tempo(100)
    .swing(0)
    .key('c')
    .scale('major');

  session.instrument('bass', async () => {
    return new Tone.MonoSynth().toDestination();
  });

  session.phrase('walk-the-abc-scale', ({ phrase }) => {
    phrase.steps(
      quarter.note('c2'),
      eighth.note('d2'),
      eighth.note('e2'),
      eighth.note('f2'),
      eighth.note('g2'),
      eighth.note('a2'),
      eighth.note('b2'),
      quarter.note('c3')
    );
  });

  // Create a track for bass
  session.track('bass', async ({ track }) => {
    track.at.measure(0)
      .volume(1)
      .pan(-0.5)
      .mute(false)
      .solo(false);

    track.at.measure(0).play.phrase('walk-the-abc-scale');
  });

  // Route instruments to tracks
  session.send.instrument('bass').to.track('bass');

});
