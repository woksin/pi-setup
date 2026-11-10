"""Docker under disk pressure: below the floor every image no container uses is removed (pins ignored)."""
import unittest
from unittest.mock import patch

from test_pi_cleanup import cleanup
from test_pi_cleanup_images import Docker, ImageCase, stamp  # noqa: F401


class PressureTests(ImageCase):
    def plan_pressure(self, docker, pressure, pins='mongo:*\n'):
        (self.state / 'pinned.txt').write_text(pins)
        with patch.object(cleanup, 'run', side_effect=docker):
            return cleanup.plan_rmi(7, None, 2, [], pressure=pressure)

    def test_pinned_image_kept_above_the_floor_and_removed_below_it(self):
        docker = Docker([self.image('mongo:7', created=30, last=30)])
        self.assertEqual(self.plan_pressure(docker, False)[0], [])
        cands, kept, err = self.plan_pressure(docker, True)
        self.assertIsNone(err)
        self.assertEqual((self.ids(cands), cands[0]['pin']), (['sha256:a'], 'mongo:*'))

    def test_container_used_image_is_kept_both_ways(self):
        docker = Docker([self.image('mongo:7', created=30, last=30)], [('c1', 'sha256:a', 'mongo:7')])
        for pressure in (False, True):
            self.assertEqual(self.plan_pressure(docker, pressure)[0], [])

    def test_young_and_unknown_age_images_stay_under_pressure(self):
        docker = Docker([self.image('x/a:1', created=30, last=0.01, iid='sha256:a'),
                         self.image('x/b:1', created=0.01, last=30, iid='sha256:b'),
                         self.image('x/c:1', created=30, last='0001-01-01T00:00:00Z', iid='sha256:c')])
        cands, _, _ = self.plan_pressure(docker, True)
        self.assertEqual(self.ids(cands), [])

    def test_age_and_dev_rules_are_ignored_under_pressure(self):
        docker = Docker([self.image('x/new:1', created=2, last=2, iid='sha256:a')])
        self.assertEqual(self.plan_pressure(docker, False)[0], [])
        self.assertEqual(self.ids(self.plan_pressure(docker, True)[0]), ['sha256:a'])

    def test_multi_tag_is_untagged_per_tag_without_force_or_prune(self):
        tags = ['mongo:7', 'mongo:latest']
        docker = Docker([self.image(tags, created=30, last=30)])
        cands, _, _ = self.plan_pressure(docker, True)
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.remove_image(cands[0])
        self.assertEqual(docker.rmis(), [['docker', 'rmi', t] for t in tags])
        self.assertFalse([c for c in docker.calls if 'prune' in c or '-f' in c[:3] or '--force' in c])

    def test_refused_rmi_is_reported_kept(self):
        docker = Docker([self.image('mongo:7', created=30, last=30)])
        cands, _, _ = self.plan_pressure(docker, True)

        def refuse(cmd, **kw):
            if cmd[:2] == ['docker', 'rmi']:
                return 1, '', 'Error: conflict: unable to delete (must be forced) - image is being used'
            return docker(cmd, **kw)
        with patch.object(cleanup, 'run', side_effect=refuse):
            cleanup.remove_image(cands[0])
        self.assertTrue(cands[0]['result'].startswith('skipped'))
        self.assertFalse(cands[0].get('failed'))


class PlanDockerPressureTests(ImageCase):
    def ctx(self, *flags):
        ctx = cleanup.Ctx(cleanup.parse_args(list(flags)))
        ctx.docker_up = True
        ctx.checkouts = [self.checkout]
        return ctx

    def plan(self, ctx, phases_safe=True):
        docker = Docker([self.image('mongo:7', created=30, last=30)])
        base = docker.__call__

        def run(cmd, **kw):
            if cmd[:3] == ['docker', 'system', 'df']:
                return 0, '', ''
            return base(cmd, **kw)
        with patch.object(cleanup, 'run', side_effect=run), \
                patch.object(cleanup, 'docker_phases_safe', return_value=phases_safe):
            (self.state / 'pinned.txt').write_text('mongo:*\n')
            return cleanup.plan_docker(ctx)

    def test_flag_default_and_forced_pressure(self):
        self.assertIsNone(cleanup.parse_args([]).docker_pressure_gib)
        d = self.plan(self.ctx('--docker-pressure-gib', '100000000'))
        self.assertTrue(d['pressure'])
        self.assertEqual(len(d['rmi']), 1)
        self.assertTrue(any('pressure: pins ignored' in n for n in d['notes']))
        self.assertIn('docker builder prune -f', [p['cmd'] for p in d['prunes']])

    def test_no_pressure_above_the_floor_keeps_pins_and_filters(self):
        d = self.plan(self.ctx('--docker-pressure-gib', '0'))
        self.assertFalse(d['pressure'])
        self.assertEqual(d['rmi'], [])
        self.assertTrue(any('until=72h' in p['cmd'] for p in d['prunes']))

    def test_running_integration_phase_disables_pressure(self):
        d = self.plan(self.ctx('--docker-pressure-gib', '100000000'), phases_safe=False)
        self.assertFalse(d['pressure'])
        self.assertEqual(d['rmi'], [])

    def test_unknown_phase_state_is_not_safe(self):
        with patch.object(cleanup, 'run', return_value=(1, '', 'boom')):
            self.assertFalse(cleanup.docker_phases_safe())
        text = 'pi-phase: integration x pid=1 cwd=/a elapsed=5s running\n'
        with patch.object(cleanup, 'run', return_value=(0, text, '')):
            self.assertFalse(cleanup.docker_phases_safe())
        with patch.object(cleanup, 'run', return_value=(0, 'pi-phase: no active phases\n', '')):
            self.assertTrue(cleanup.docker_phases_safe())


if __name__ == '__main__':
    unittest.main()
