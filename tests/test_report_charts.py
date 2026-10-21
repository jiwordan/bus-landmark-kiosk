import unittest
from scripts.build_report_charts import chart_values


class ReportChartTests(unittest.TestCase):
    def fixture(self):
        return {'names': {'total': 309, 'explicit': 40, 'abbreviation_review': 18, 'not_explicit': 251},
                'totals': [{'mobileNo': '07159', 'total': 498, 'currentAlternativeDespiteNearestOutside': 93},
                           {'mobileNo': '07303', 'total': 498, 'currentAlternativeDespiteNearestOutside': 128}]}

    def test_counts_are_taken_from_saved_analysis_not_user_error_measurements(self):
        result = chart_values(self.fixture())
        self.assertEqual(result['names'], [40, 18, 251])
        self.assertEqual(result['namesTotal'], 309)
        self.assertEqual(result['directions'], [('07159', 93, 498), ('07303', 128, 498)])

    def test_inconsistent_population_or_case_counts_fail(self):
        data = self.fixture()
        data['names']['total'] = 310
        with self.assertRaises(ValueError):
            chart_values(data)
        data = self.fixture()
        data['totals'][0]['currentAlternativeDespiteNearestOutside'] = 499
        with self.assertRaises(ValueError):
            chart_values(data)


if __name__ == '__main__':
    unittest.main()
